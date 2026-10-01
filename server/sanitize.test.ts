import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizePrompt } from './sanitize.js'

test('keeps the task while hiding common credentials and personal data', () => {
  const prompt = [
    'Investigate why this deployment is slow.',
    'Authorization: Bearer abc.def-1234567890',
    'API_KEY="myPlainTextPassword"',
    'client_secret: "another-plain-value"',
    'Use https://admin:pass123@example.com/path?token=abc123',
    'Email me at person@example.com or call 11 91234-5678.',
    'CPF 123.456.789-09',
    'The unknown value is A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6.',
  ].join('\n')
  const sanitized = sanitizePrompt(prompt)
  assert.match(sanitized!, /Investigate why this deployment is slow/)
  for (const secret of ['abc.def-1234567890', 'myPlainTextPassword', 'another-plain-value',
    'admin:pass123', 'abc123', 'person@example.com', '91234-5678', '123.456.789-09',
    'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6']) assert.equal(sanitized!.includes(secret), false, secret)
  assert.match(sanitized!, /\[REDACTED\]/)
})

test('hides private key blocks and JWTs', () => {
  const sanitized = sanitizePrompt('Fix auth: -----BEGIN PRIVATE KEY-----\nprivate-content\n-----END PRIVATE KEY----- eyJaaaaaaaabbbbbbbb.ccccccccdddddddd.eeeeeeeeffffffff')
  assert.match(sanitized!, /Fix auth/)
  assert.doesNotMatch(sanitized!, /private-content|eyJaaaa/)
})

test('hides ambiguous assignment values and short opaque tokens', () => {
  const sanitized = sanitizePrompt('Please debug {"password": "two word phrase"}.\nsenha é frase com espaços.\ncode Ab12Cd34Ef56Gh78')
  assert.match(sanitized!, /Please debug/)
  assert.doesNotMatch(sanitized!, /two word phrase|frase com espaços|Ab12Cd34Ef56Gh78/)
})

test('omits oversized or already redacted prompts', () => {
  assert.equal(sanitizePrompt('a'.repeat(16_001)), '[PROMPT OMITTED: TOO LONG]')
  assert.equal(sanitizePrompt('<REDACTED>'), null)
  assert.equal(sanitizePrompt(undefined), null)
})
