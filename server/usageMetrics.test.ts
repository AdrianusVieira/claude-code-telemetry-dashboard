import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeUsage } from '../src/usageMetrics.js'

test('summarizes request and linked-prompt usage without counting unlinked prompts', () => {
  const summary = summarizeUsage([
    { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
    { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
    { input: 10, output: 0, cacheRead: 80, cacheWrite: 0 },
  ], [
    { id: 'low', text: 'Small unrelated request', requests: 1, tokens: 10 },
    { id: 'first', text: 'Investigate cache timeout in client request', requests: 2, tokens: 50 },
    { id: 'second', text: 'Investigate cache timeout in server request', requests: 2, tokens: 60 },
    { id: 'unlinked', text: 'No linked request', requests: 0, tokens: 0 },
  ])
  assert.equal(summary.requestAverage, 40)
  assert.equal(summary.requestMedian, 20)
  assert.equal(summary.promptAverage, 40)
  assert.equal(summary.promptMedian, 50)
  assert.equal(summary.linkedPromptCount, 3)
  assert.deepEqual(summary.aboveAverage.map((prompt) => prompt.id), ['second', 'first'])
  assert.equal(summary.aboveTotal, 110)
  assert.equal(summary.similarPairs.length, 1)
  assert.ok(summary.similarPairs[0].score > 0.6)
})

test('shows no averages or wording matches when usage is unavailable', () => {
  const summary = summarizeUsage([], [{ id: 'no-requests', text: null, requests: 0, tokens: 0 }])
  assert.equal(summary.requestAverage, null)
  assert.equal(summary.requestMedian, null)
  assert.equal(summary.promptAverage, null)
  assert.equal(summary.promptMedian, null)
  assert.deepEqual(summary.aboveAverage, [])
  assert.deepEqual(summary.similarPairs, [])
})
