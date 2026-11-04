import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import {acquireGraphicsSession, createGraphicsSession} from '../lab/graphics-session.ts';

// Real Effect scopes/fibers with renderer/event doubles. This is lifecycle evidence,
// not a GPU support, shader compilation, or browser rendering claim.
function fixture(prepare) {
  const events = [], canvas = new EventTarget();
  const context = {lost: false, isContextLost() {return this.lost;}};
  canvas.getContext = () => context;
  const options = {
    canvas,
    createRenderer() {
      events.push('renderer acquired');
      return {
        debug: {}, getContext: () => context,
        render() {events.push('render');},
        dispose() {events.push('renderer released');},
      };
    },
    prepare: prepare ?? (() => own('lighting', events).pipe(Effect.asVoid)),
    onChange() {},
  };
  return {
    options, canvas, context, events,
    start() {const session = createGraphicsSession(options); session.start(); session.render({}, {}); return session;},
    lose() {context.lost = true; canvas.dispatchEvent(new Event('webglcontextlost', {cancelable: true}));},
  };
}

function own(name, events, releaseError) {
  return Effect.acquireRelease(
    Effect.sync(() => {events.push(`${name} acquired`); return name;}),
    () => Effect.sync(() => {
      events.push(`${name} released`);
      if (releaseError) throw releaseError;
    }),
  );
}

function pendingCapture(events) {
  let resume;
  return {
    effect: Effect.acquireUseRelease(
      Effect.sync(() => events.push('capture acquired')),
      () => Effect.callback(complete => {resume = complete;}),
      () => Effect.sync(() => events.push('capture released')),
    ),
    complete(value) {resume(Effect.succeed(value));},
  };
}

test('an enclosing Effect scope owns the renderer, prepared resources, and context listeners', () => {
  const f = fixture();
  const session = Effect.runSync(Effect.scoped(Effect.gen(function* () {
    const current = yield* acquireGraphicsSession(f.options);
    current.start(); current.render({}, {});
    assert.equal(current.available, true);
    return current;
  })));
  assert.deepEqual(f.events, ['renderer acquired', 'lighting acquired', 'render', 'lighting released', 'renderer released']);
  assert.equal(session.state.status, 'disposed');
  const generation = session.generation;
  const event = new Event('webglcontextlost', {cancelable: true});
  f.canvas.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(session.generation, generation);
  session.dispose();
  assert.equal(f.events.filter(value => value === 'renderer released').length, 1);
});

test('failed preparation releases each successful acquisition immediately in reverse order', () => {
  let f;
  f = fixture(() => Effect.gen(function* () {
    yield* own('environment', f.events);
    yield* own('shadow', f.events);
    yield* Effect.fail(new Error('material preparation failed'));
  }));
  const session = createGraphicsSession(f.options);
  assert.equal(session.start(), false);
  assert.equal(session.state.status, 'failed'); assert.equal(session.state.phase, 'prepare');
  assert.equal(session.state.error.message, 'material preparation failed');
  assert.equal(session.renderer, null);
  assert.deepEqual(f.events, [
    'renderer acquired', 'environment acquired', 'shadow acquired',
    'shadow released', 'environment released', 'renderer released',
  ]);
  session.dispose();
  assert.equal(f.events.length, 6);
});

test('one failing finalizer does not skip other resources or leave the session usable', () => {
  let f;
  f = fixture(() => Effect.gen(function* () {
    yield* own('environment', f.events, new Error('environment cleanup failed'));
    yield* own('shadow', f.events, new Error('shadow cleanup failed'));
  }));
  const session = f.start();
  assert.throws(() => session.dispose());
  assert.deepEqual(f.events.slice(-3), ['shadow released', 'environment released', 'renderer released']);
  assert.equal(session.renderer, null);
  assert.deepEqual(session.state, {status: 'disposed', phase: null, error: null, profile: 'standard', creationMessage: null});
  assert.equal(session.render({}, {}), false);
  assert.doesNotThrow(() => session.dispose());
});

test('interrupting an application fiber closes its scoped renderer', async () => {
  const f = fixture();
  let session;
  const application = Effect.runFork(Effect.scoped(Effect.gen(function* () {
    session = yield* acquireGraphicsSession(f.options);
    session.start(); session.render({}, {});
    yield* Effect.never;
  })));
  assert.equal(session.available, true);
  await Effect.runPromise(Fiber.interrupt(application));
  assert.equal(session.state.status, 'disposed');
  assert.deepEqual(f.events.slice(-2), ['lighting released', 'renderer released']);
});

for (const transition of ['loss', 'retry', 'dispose']) {
  test(`${transition} cancels a pending capture and ignores its eventual browser callback`, async () => {
    const f = fixture(), session = f.start(), capture = pendingCapture(f.events);
    const result = Effect.runPromise(session.whileReady(capture.effect));
    assert(f.events.includes('capture acquired'));
    if (transition === 'loss') f.lose();
    else if (transition === 'retry') session.start('reduced');
    else session.dispose();
    assert.equal(await result, null);
    assert.equal(f.events.filter(value => value === 'capture released').length, 1);
    capture.complete({blob: 'old pixels', filename: 'old-scene.png'});
    await Promise.resolve();
    assert.equal(f.events.filter(value => value === 'capture released').length, 1);
    if (transition === 'loss') {
      assert.equal(session.state.status, 'lost');
      assert.equal(f.events.includes('renderer released'), false, 'Three retains its context-restoration listener until retry');
    } else {
      assert(f.events.indexOf('capture released') < f.events.indexOf('lighting released'));
    }
    session.dispose();
  });
}

test('caller cancellation releases capture work while leaving the preview ready', async () => {
  const f = fixture(), session = f.start(), capture = pendingCapture(f.events), caller = new AbortController();
  const result = Effect.runPromiseExit(session.whileReady(capture.effect), {signal: caller.signal});
  caller.abort();
  const exit = await result;
  assert(Exit.isFailure(exit)); assert(Cause.hasInterruptsOnly(exit.cause));
  assert.equal(session.available, true);
  assert.equal(f.events.filter(value => value === 'capture released').length, 1);
  capture.complete('stale');
  session.dispose();
});

test('capture errors keep their typed error while successful captures preserve their result', async () => {
  const f = fixture(), session = f.start(), error = new Error('PNG encoding failed');
  const failed = await Effect.runPromiseExit(session.whileReady(Effect.fail(error)));
  assert(Exit.isFailure(failed)); assert.equal(Cause.squash(failed.cause), error);
  const expected = {blob: 'pixels', filename: 'accepted-scene.png'};
  assert.equal(await Effect.runPromise(session.whileReady(Effect.succeed(expected))), expected);
  assert.equal(session.available, true);
  session.dispose();
});

test('work cannot start offline and a synchronous loss cannot deliver a stale result', async () => {
  const f = fixture(), session = createGraphicsSession(f.options);
  let started = 0;
  assert.equal(await Effect.runPromise(session.whileReady(Effect.sync(() => ++started))), null);
  assert.equal(started, 0);
  session.start(); session.render({}, {});
  const result = await Effect.runPromise(session.whileReady(Effect.sync(() => {
    f.lose();
    return 'pixels from the lost renderer';
  })));
  assert.equal(result, null);
  session.dispose();
});
