/**
 * Unit tests for the CAPTCHA module.  Run:  node --test test/
 *
 * The answer is deliberately not reachable from outside the module, so the
 * accept path is proven statistically: issue many challenges and guess a
 * different value against each. Every possible answer is 0..18, so across
 * 120 challenges a hit is a near-certainty — while a single challenge still
 * only ever gets one attempt.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { issueCaptcha, verifyCaptcha } from '../server/lib/captcha.js'

test('issues a well-formed challenge', () => {
  const c = issueCaptcha()
  assert.match(c.id, /^[0-9a-f]{64}$/, 'id should be a 64-hex token')
  assert.equal(typeof c.svg, 'string')
  assert.ok(c.svg.startsWith('<svg'), 'svg payload')
  assert.equal(c.ttl, 300)
})

test('answer never appears in the markup', () => {
  for (let i = 0; i < 50; i++) {
    const { svg } = issueCaptcha()
    assert.ok(!/<text/i.test(svg), 'must not use <text>')
    assert.ok(!/aria-label="[^"]*\d/.test(svg), 'must not leak digits via aria-label')
    // strip coordinates/dimensions, then assert no bare arithmetic survives
    const stripped = svg.replace(/"[^"]*"/g, '""')
    assert.ok(!/\d/.test(stripped), 'no digits outside attribute values')
  }
})

test('ids are unique', () => {
  const seen = new Set()
  for (let i = 0; i < 200; i++) seen.add(issueCaptcha().id)
  assert.equal(seen.size, 200)
})

test('accepts the correct answer', () => {
  let accepted = 0
  for (let i = 0; i < 120; i++) {
    const { id } = issueCaptcha()
    if (verifyCaptcha(id, String(i % 19))) accepted++
  }
  assert.ok(accepted > 0, 'a correct guess must be accepted at least once')
})

test('rejects an unknown or forged id', () => {
  assert.equal(verifyCaptcha('deadbeef', '5'), false)
  assert.equal(verifyCaptcha('', '5'), false)
  assert.equal(verifyCaptcha(undefined, '5'), false)
  assert.equal(verifyCaptcha(null, null), false)
})

test('a challenge is single-use even when the first try is wrong', () => {
  // 19 possible answers; the first guess is wrong for at least one of two ids
  let provedConsumed = false
  for (let i = 0; i < 40 && !provedConsumed; i++) {
    const { id } = issueCaptcha()
    if (verifyCaptcha(id, '999') === false) {
      // second attempt on the same id must fail no matter what is supplied
      for (let g = 0; g <= 18; g++) assert.equal(verifyCaptcha(id, String(g)), false)
      provedConsumed = true
    }
  }
  assert.ok(provedConsumed)
})

test('tolerates surrounding whitespace', () => {
  let checked = 0
  for (let i = 0; i < 120 && checked < 1; i++) {
    const { id } = issueCaptcha()
    if (verifyCaptcha(id, `  ${i % 19}  `)) checked++
  }
  assert.equal(checked, 1, 'padded input should still validate')
})
