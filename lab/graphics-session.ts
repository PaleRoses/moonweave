import * as Cause from 'effect/Cause';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Scope from 'effect/Scope';
import type {Camera, Object3D, WebGLRenderer} from 'three';

export type GraphicsProfile = 'standard' | 'reduced';
export type GraphicsStatus = 'idle' | 'starting' | 'ready' | 'unavailable' | 'lost' | 'failed' | 'disposed';
export type GraphicsPhase = 'context' | 'renderer' | 'prepare' | 'shader' | 'render' | 'release' | 'first-frame';
type FailurePhase = Exclude<GraphicsPhase, 'first-frame'>;
export interface GraphicsError {
  readonly name: string;
  readonly message: string;
  readonly logs?: Readonly<{program: string | null; vertex: string | null; fragment: string | null}>;
}
type GraphicsTransition =
  | {readonly status: 'idle' | 'ready' | 'disposed'; readonly phase: null; readonly error: null}
  | {readonly status: 'starting'; readonly phase: 'context' | 'first-frame'; readonly error: null}
  | {readonly status: 'lost'; readonly phase: 'context'; readonly error: null}
  | {readonly status: 'unavailable'; readonly phase: 'context'; readonly error: GraphicsError}
  | {readonly status: 'failed'; readonly phase: Exclude<FailurePhase, 'context'>; readonly error: GraphicsError};
export type GraphicsState = GraphicsTransition & {
  readonly profile: GraphicsProfile;
  readonly creationMessage: string | null;
};
export const initialGraphicsState: GraphicsState = {
  status: 'idle', phase: null, profile: 'standard', error: null, creationMessage: null,
};

type Renderer = Pick<WebGLRenderer, 'getContext' | 'render' | 'dispose' | 'debug'>;
type Canvas = Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener'> & {
  getContext(name: 'webgl2', attributes: WebGLContextAttributes): WebGL2RenderingContext | null;
};
export interface GraphicsOptions<R extends Renderer> {
  readonly canvas: Canvas;
  readonly createRenderer: (context: WebGL2RenderingContext) => R;
  /** Synchronous GPU setup; each acquired resource belongs to this attempt's scope. */
  readonly prepare: (renderer: R, profile: GraphicsProfile) => Effect.Effect<void, unknown, Scope.Scope>;
  readonly onChange: (state: GraphicsState) => void;
}
export interface GraphicsSession<R extends Renderer = Renderer> {
  readonly start: (profile?: GraphicsProfile) => boolean;
  readonly render: (scene: Object3D, camera: Camera) => boolean;
  readonly renderer: R | null;
  readonly state: GraphicsState;
  readonly generation: number;
  readonly canRender: boolean;
  readonly available: boolean;
  /** Pending work is canceled when this ready renderer is lost, replaced, or disposed. */
  readonly whileReady: <A, E>(operation: Effect.Effect<A, E>) => Effect.Effect<A | null, E>;
  readonly dispose: () => void;
}

class ShaderCompileError extends Error {
  readonly logs: NonNullable<GraphicsError['logs']>;
  constructor(logs: NonNullable<GraphicsError['logs']>) {
    super('A preview shader could not compile or link.');
    this.name = 'ShaderCompileError';
    this.logs = logs;
  }
}
class GraphicsFailure extends Error {
  readonly phase: FailurePhase;
  readonly detail: GraphicsError;
  constructor(phase: FailurePhase, cause: unknown) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    super(error.message, {cause});
    this.name = 'GraphicsFailure';
    this.phase = error instanceof ShaderCompileError ? 'shader' : phase;
    this.detail = {
      name: error.name, message: error.message,
      ...(error instanceof ShaderCompileError ? {logs: error.logs} : {}),
    };
  }
}
const atPhase = <A, E, R>(phase: FailurePhase, effect: Effect.Effect<A, E, R>) =>
  Effect.catchCause(effect, cause => Effect.fail(new GraphicsFailure(phase, Cause.squash(cause))));

/** Session ownership is a scope; every renderer attempt gets a replaceable child scope. */
function sessionInScope<R extends Renderer>(options: GraphicsOptions<R>, scope: Scope.Closeable) {
  return Effect.gen(function* () {
    const {canvas, createRenderer, prepare, onChange} = options;
    let renderer: R | null = null;
    let attempt: Scope.Closeable | null = null;
    let operations: Scope.Closeable | null = null;
    let generation = 0;
    let state = initialGraphicsState;
    const canRender = () => state.status === 'ready' || (state.status === 'starting' && state.phase === 'first-frame');
    function change(next: GraphicsTransition, fields: Partial<Pick<GraphicsState, 'profile' | 'creationMessage'>> = {}) {
      state = {profile: state.profile, creationMessage: state.creationMessage, ...fields, ...next};
      onChange(state);
    }
    const closeOperations = Effect.suspend(() => {
      const previous = operations;
      operations = null;
      return previous ? Scope.close(previous, Exit.void) : Effect.void;
    });
    const releaseAttempt = Effect.suspend(() => {
      const previous = attempt;
      attempt = null; operations = null; renderer = null;
      return previous ? Scope.close(previous, Exit.void) : Effect.void;
    });
    function lost() {
      if (state.status === 'disposed' || state.status === 'lost') return;
      generation++;
      change({status: 'lost', phase: 'context', error: null});
      Effect.runSync(closeOperations);
    }
    function fail(failure: GraphicsFailure) {
      generation++;
      change(failure.phase === 'context'
        ? {status: 'unavailable', phase: 'context', error: failure.detail}
        : {status: 'failed', phase: failure.phase, error: failure.detail});
      Effect.runSync(closeOperations);
      return false;
    }
    const listen = (name: string, callback: EventListener) => Effect.acquireRelease(
      Effect.sync(() => {canvas.addEventListener(name, callback); return callback;}),
      listener => Effect.sync(() => canvas.removeEventListener(name, listener)),
    );
    yield* listen('webglcontextcreationerror', event => {
      state = {...state, creationMessage: (event as WebGLContextEvent).statusMessage || null};
      onChange(state);
    });
    yield* listen('webglcontextlost', event => {event.preventDefault(); lost();});
    yield* listen('webglcontextrestored', () => {
      // Three also restores on this event. Rebuild GPU data after its listener finishes.
      const expected = generation;
      queueMicrotask(() => {if (state.status !== 'disposed' && expected === generation) start(state.profile);});
    });
    yield* Effect.addFinalizer(() => releaseAttempt);
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      generation++;
      change({status: 'disposed', phase: null, error: null});
    }));

    function start(profile = state.profile): boolean {
      if (state.status === 'disposed') return false;
      state = {...state, profile};
      if (renderer?.getContext().isContextLost()) {
        if (state.status === 'lost') onChange(state);
        else lost();
        return false;
      }
      generation++;
      change({status: 'starting', phase: 'context', error: null}, {profile, creationMessage: null});
      let context: WebGL2RenderingContext | null = null;
      const exit = Effect.runSyncExit(Effect.gen(function* () {
        // A canvas must release its old renderer before the replacement uses the same context.
        yield* atPhase('release', releaseAttempt);
        context = yield* atPhase('context', Effect.sync(() => {
          const gl = canvas.getContext('webgl2', {alpha: true, antialias: true});
          if (!gl) throw new Error('The browser did not provide a WebGL2 context.');
          return gl;
        }));
        if (context.isContextLost()) {lost(); return false;}
        const next = yield* Scope.fork(scope);
        attempt = next;
        return yield* Effect.gen(function* () {
          renderer = yield* Effect.acquireRelease(
            atPhase('renderer', Effect.sync(() => createRenderer(context!))),
            current => Effect.sync(() => current.dispose()),
          );
          renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
            throw new ShaderCompileError({
              program: gl.getProgramInfoLog(program),
              vertex: gl.getShaderInfoLog(vertex), fragment: gl.getShaderInfoLog(fragment),
            });
          };
          yield* atPhase('prepare', prepare(renderer, profile));
          operations = yield* Scope.fork(next);
          change({status: 'starting', phase: 'first-frame', error: null});
          return true;
        }).pipe(
          Scope.provide(next),
          Effect.tapCause(() => releaseAttempt),
        );
      }));
      if (Exit.isSuccess(exit)) return exit.value;
      // The context outlives a failed renderer acquisition and identifies genuine loss.
      if ((context as WebGL2RenderingContext | null)?.isContextLost()) {lost(); return false;}
      const error = Cause.squash(exit.cause);
      return fail(error instanceof GraphicsFailure ? error : new GraphicsFailure('prepare', error));
    }
    function render(scene: Object3D, camera: Camera): boolean {
      if (!canRender()) return false;
      const current = renderer!;
      if (current.getContext().isContextLost()) {lost(); return false;}
      try {
        current.render(scene, camera);
        if (current.getContext().isContextLost()) {lost(); return false;}
        if (state.status === 'starting') change({status: 'ready', phase: null, error: null});
        return true;
      } catch (error) {
        if (current.getContext().isContextLost()) {lost(); return false;}
        return fail(new GraphicsFailure('render', error));
      }
    }
    function whileReady<A, E>(operation: Effect.Effect<A, E>): Effect.Effect<A | null, E> {
      return Effect.suspend(() => {
        if (state.status !== 'ready' || !operations) return Effect.succeed(null);
        const expectedGeneration = generation;
        return Effect.acquireUseRelease(
          Effect.forkIn(operation, operations, {startImmediately: true}),
          fiber => Effect.flatMap(Fiber.await(fiber), exit => {
            if (Exit.isSuccess(exit)) return Effect.succeed<A | null>(
              state.status === 'ready' && generation === expectedGeneration ? exit.value : null,
            );
            return Cause.hasInterruptsOnly(exit.cause) ? Effect.succeed(null) : Effect.failCause(exit.cause);
          }),
          Fiber.interrupt,
        );
      });
    }
    return {
      start, render, whileReady,
      get renderer() {return renderer;},
      get state() {return state;},
      get generation() {return generation;},
      get canRender() {return canRender();},
      get available() {return state.status === 'ready';},
      dispose: () => Effect.runSync(Scope.close(scope, Exit.void)),
    } satisfies GraphicsSession<R>;
  }).pipe(Scope.provide(scope));
}

/** Compose the renderer lifetime into an enclosing application/test scope. */
export function acquireGraphicsSession<R extends Renderer>(options: GraphicsOptions<R>) {
  return Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope);
    return yield* sessionInScope(options, scope).pipe(Effect.tapCause(cause => Scope.close(scope, Exit.failCause(cause))));
  });
}

/** Synchronous browser boundary for the scoped GPU API. */
export function createGraphicsSession<R extends Renderer>(options: GraphicsOptions<R>): GraphicsSession<R> {
  const scope = Effect.runSync(Scope.make());
  return Effect.runSync(sessionInScope(options, scope).pipe(Effect.tapCause(cause => Scope.close(scope, Exit.failCause(cause)))));
}

export function graphicsMessage({status, phase}: Pick<GraphicsState, 'status' | 'phase'>) {
  if (status === 'lost') return {
    title: 'Live preview interrupted',
    message: 'The browser lost its graphics context. Your composition is preserved. The preview will restart if graphics return; you can keep editing and export the graph.',
  };
  if (status === 'unavailable') return {
    title: 'Live 3D preview could not start',
    message: 'This page could not obtain WebGL2. Open Graphics details for the browser’s reason. You can retry, or open Moonweave in a regular browser tab. Editing and graph export remain available.',
  };
  if (status === 'failed') return {
    title: phase === 'shader' ? 'A preview shader failed' : 'The preview encountered an error',
    message: 'WebGL2 was available, but the preview failed. Your composition is preserved. Retry, try reduced load, or switch to Clay or Normals to isolate the material. Graphics details contains the error.',
  };
  return {title: 'Starting live preview', message: 'Preparing the current surface and lighting.'};
}
