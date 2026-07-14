import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CallStateMachine, type CallState, type CallStateChange } from './call-state.ts';

test('starts idle and not terminal', () => {
  const m = new CallStateMachine();
  assert.equal(m.state, 'idle');
  assert.equal(m.isTerminal, false);
});

test('happy outgoing path: idle -> ringing -> connecting -> connected -> ended', () => {
  const m = new CallStateMachine();
  const seen: CallState[] = [];
  m.subscribe((s) => seen.push(s));

  assert.equal(m.transition('ringing'), true);
  assert.equal(m.transition('connecting'), true);
  assert.equal(m.transition('connected'), true);
  assert.equal(m.transition('ended'), true);

  assert.deepEqual(seen, ['ringing', 'connecting', 'connected', 'ended']);
  assert.equal(m.state, 'ended');
  assert.equal(m.isTerminal, true);
});

test('happy incoming path is the same shape (ringing then connecting on accept)', () => {
  const m = new CallStateMachine();
  assert.equal(m.transition('ringing'), true); // IncomingCall
  assert.equal(m.transition('connecting'), true); // accept()
  assert.equal(m.transition('connected'), true);
  assert.equal(m.state, 'connected');
});

test('notifies with the exact {from,to} change object', () => {
  const m = new CallStateMachine();
  const changes: CallStateChange[] = [];
  m.subscribe((_s, change) => changes.push(change));
  m.transition('ringing');
  m.transition('connecting');
  assert.deepEqual(changes, [
    { from: 'idle', to: 'ringing' },
    { from: 'ringing', to: 'connecting' },
  ]);
});

test('rejects skips: idle cannot jump straight to connected/connecting', () => {
  const m = new CallStateMachine();
  let notified = 0;
  m.subscribe(() => (notified += 1));
  assert.equal(m.transition('connected'), false);
  assert.equal(m.transition('connecting'), false);
  assert.equal(m.state, 'idle');
  assert.equal(notified, 0, 'a rejected transition must not notify');
});

test('cannot go backwards: connected -> ringing/connecting is rejected', () => {
  const m = new CallStateMachine();
  m.transition('ringing');
  m.transition('connecting');
  m.transition('connected');
  assert.equal(m.transition('ringing'), false);
  assert.equal(m.transition('connecting'), false);
  assert.equal(m.state, 'connected');
});

test('same-state transition is a no-op that returns false and does not notify', () => {
  const m = new CallStateMachine();
  m.transition('ringing');
  let notified = 0;
  m.subscribe(() => (notified += 1));
  assert.equal(m.transition('ringing'), false);
  assert.equal(notified, 0);
  assert.equal(m.state, 'ringing');
});

test('ended is reachable from every non-ended state (teardown always wins)', () => {
  for (const setup of [
    (m: CallStateMachine) => {},
    (m: CallStateMachine) => m.transition('ringing'),
    (m: CallStateMachine) => (m.transition('ringing'), m.transition('connecting')),
    (m: CallStateMachine) => (
      m.transition('ringing'), m.transition('connecting'), m.transition('connected')
    ),
  ]) {
    const m = new CallStateMachine();
    setup(m);
    assert.equal(m.transition('ended'), true, `should reach ended from ${m.state}`);
    assert.equal(m.state, 'ended');
  }
});

test('ended is terminal: every further transition is a silent no-op (the race guard)', () => {
  const m = new CallStateMachine();
  m.transition('ended');
  let notified = 0;
  m.subscribe(() => (notified += 1));
  // A late gather promise / connectionstatechange after hang up must NOT
  // resurrect the call.
  for (const to of ['idle', 'ringing', 'connecting', 'connected', 'ended'] as const) {
    assert.equal(m.transition(to), false, `ended -> ${to} must be rejected`);
  }
  assert.equal(m.state, 'ended');
  assert.equal(notified, 0);
});

test('canTransition reflects transition without mutating', () => {
  const m = new CallStateMachine();
  assert.equal(m.canTransition('ringing'), true);
  assert.equal(m.canTransition('connected'), false);
  assert.equal(m.state, 'idle', 'canTransition must not mutate');
});

test('unsubscribe stops delivery', () => {
  const m = new CallStateMachine();
  const seen: CallState[] = [];
  const off = m.subscribe((s) => seen.push(s));
  m.transition('ringing');
  off();
  m.transition('connecting');
  assert.deepEqual(seen, ['ringing']);
});

test('multiple subscribers all fire; unsubscribing during dispatch is safe', () => {
  const m = new CallStateMachine();
  const a: CallState[] = [];
  const b: CallState[] = [];
  const offB = m.subscribe(() => {
    // Unsubscribe a sibling from within a listener — must not corrupt dispatch.
    offB();
  });
  m.subscribe((s) => a.push(s));
  m.subscribe((s) => b.push(s));
  m.transition('ringing');
  m.transition('connecting');
  assert.deepEqual(a, ['ringing', 'connecting']);
  assert.deepEqual(b, ['ringing', 'connecting']);
});
