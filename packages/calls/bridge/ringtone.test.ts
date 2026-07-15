import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RingtonePlayer, vibratePattern } from './ringtone.ts'

test('vibratePattern: repeats [on, off] pairs', () => {
  assert.deepEqual(vibratePattern(0), [])
  assert.deepEqual(vibratePattern(1), [1000, 1000])
  assert.deepEqual(vibratePattern(3), [1000, 1000, 1000, 1000, 1000, 1000])
})

// ── RingtonePlayer with fully-faked AudioContext/vibrate seams ────────────────
// Mirrors how engine/*.test.ts fakes RTCPeerConnection/AnalyserNode: no real
// Web Audio in a `node --test` environment, so every DOM/Audio call is a
// hand-rolled stub recording what happened.

function fakeAudioContext() {
  const calls: string[] = []
  const gainValues: number[] = []
  let started = false
  let stopped = false
  const ctx = {
    state: 'running',
    resume: async () => {},
    close: async () => {
      calls.push('close')
    },
    createGain: () => ({
      gain: {
        set value(v: number) {
          gainValues.push(v)
        },
        get value() {
          return gainValues.at(-1) ?? 0
        },
      },
      connect: () => calls.push('gain.connect'),
      disconnect: () => calls.push('gain.disconnect'),
    }),
    createOscillator: () => ({
      type: 'sine',
      frequency: { value: 0 },
      connect: () => calls.push('osc.connect'),
      start: () => {
        started = true
        calls.push('osc.start')
      },
      stop: () => {
        if (!started || stopped) throw new Error('InvalidStateError: not started')
        stopped = true
        calls.push('osc.stop')
      },
      disconnect: () => calls.push('osc.disconnect'),
    }),
    destination: {},
  }
  return { ctx, calls, gainValues }
}

test('RingtonePlayer: start() builds the audio graph, stop() tears it down', () => {
  const { ctx, calls, gainValues } = fakeAudioContext()
  const vibrateCalls: number[][] = []
  const player = new RingtonePlayer({
    createAudioContext: () => ctx as unknown as AudioContext,
    vibrate: (pattern) => {
      vibrateCalls.push(pattern)
      return true
    },
  })

  assert.equal(player.isRinging, false)
  player.start()
  assert.equal(player.isRinging, true)
  assert.ok(calls.includes('osc.start'), 'oscillator started')
  assert.ok(calls.includes('gain.connect') && calls.includes('osc.connect'))
  assert.ok(gainValues.some((v) => v > 0), 'gain gated on at least once')
  assert.equal(vibrateCalls.length, 1, 'vibration armed once on start')
  assert.ok(vibrateCalls[0].length > 0)

  player.stop()
  assert.equal(player.isRinging, false)
  assert.ok(calls.includes('osc.stop'), 'oscillator stopped')
  assert.ok(calls.includes('close'), 'AudioContext closed')
  assert.deepEqual(vibrateCalls.at(-1), [], 'stop() cancels vibration with an empty pattern')
})

test('RingtonePlayer: start() is idempotent while already ringing', () => {
  const { ctx, calls } = fakeAudioContext()
  const player = new RingtonePlayer({
    createAudioContext: () => ctx as unknown as AudioContext,
    vibrate: () => true,
  })
  player.start()
  const startCallsAfterFirst = calls.filter((c) => c === 'osc.start').length
  player.start() // no-op — a second oscillator would throw on stop() otherwise
  const startCallsAfterSecond = calls.filter((c) => c === 'osc.start').length
  assert.equal(startCallsAfterFirst, 1)
  assert.equal(startCallsAfterSecond, 1)
  player.stop()
})

test('RingtonePlayer: stop() before start() is a harmless no-op', () => {
  const player = new RingtonePlayer({ vibrate: () => true })
  assert.doesNotThrow(() => player.stop())
})

test('RingtonePlayer: a throwing AudioContext factory still lets vibration run', () => {
  const vibrateCalls: number[][] = []
  const player = new RingtonePlayer({
    createAudioContext: () => {
      throw new Error('Web Audio blocked')
    },
    vibrate: (pattern) => {
      vibrateCalls.push(pattern)
      return true
    },
  })
  assert.doesNotThrow(() => player.start())
  assert.equal(vibrateCalls.length, 1)
  assert.doesNotThrow(() => player.stop())
})

test('RingtonePlayer: a missing vibrate function never throws', () => {
  const { ctx } = fakeAudioContext()
  const player = new RingtonePlayer({ createAudioContext: () => ctx as unknown as AudioContext })
  assert.doesNotThrow(() => player.start())
  assert.doesNotThrow(() => player.stop())
})
