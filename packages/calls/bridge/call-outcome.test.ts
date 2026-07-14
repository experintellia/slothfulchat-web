import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyCallOutcome, type CallInfoState } from './call-outcome.ts'

const state = (kind: CallInfoState['kind'], duration?: number): CallInfoState => ({ kind, duration })

// ── Incoming ───────────────────────────────────────────────────────────────

test('classifyCallOutcome: incoming Missed -> missed', () => {
  assert.equal(classifyCallOutcome('incoming', state('Missed')), 'missed')
})

test('classifyCallOutcome: incoming Declined -> declined (we declined before accepting)', () => {
  assert.equal(classifyCallOutcome('incoming', state('Declined')), 'declined')
})

test('classifyCallOutcome: incoming unexpected kinds default to the safe "missed"', () => {
  for (const kind of ['Canceled', 'Alerting', 'Active', 'Completed'] as const) {
    assert.equal(classifyCallOutcome('incoming', state(kind, 42)), 'missed', kind)
  }
})

// ── Outgoing ───────────────────────────────────────────────────────────────

test('classifyCallOutcome: outgoing Canceled -> declined (the callee explicitly rejected)', () => {
  assert.equal(classifyCallOutcome('outgoing', state('Canceled')), 'declined')
})

test('classifyCallOutcome: outgoing Declined -> timeout (rang out, no explicit reject)', () => {
  assert.equal(classifyCallOutcome('outgoing', state('Declined')), 'timeout')
})

test('classifyCallOutcome: outgoing unexpected kinds default to the safe "timeout"', () => {
  for (const kind of ['Missed', 'Alerting', 'Active', 'Completed'] as const) {
    assert.equal(classifyCallOutcome('outgoing', state(kind, 7)), 'timeout', kind)
  }
})
