import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import * as ScopedRef from 'effect/ScopedRef';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {SPECIMENS, createSpecimen} from './specimens.mjs';
import {acquireGraphicsSession, initialGraphicsState} from './graphics-session.ts';
import type {GraphicsProfile, GraphicsSession, GraphicsState} from './graphics-session.ts';

export {SPECIMENS};
export {graphicsMessage} from './graphics-session.ts';
export type {GraphicsProfile, GraphicsState} from './graphics-session.ts';
export type SpecimenKind = keyof typeof SPECIMENS;
export type SurfaceView = 'painted' | 'clay' | 'normals';
export interface StageState {
  readonly graphics: GraphicsState;
  readonly specimen: SpecimenKind;
  readonly view: SurfaceView;
  readonly motion: boolean;
  readonly capturing: boolean;
}
export const initialStageState: StageState = {
  graphics: initialGraphicsState, specimen: 'shell', view: 'painted', motion: false, capturing: false,
};
export interface CapturedView {readonly blob: Blob; readonly filename: string}
export class CaptureError extends Error {
  readonly _tag = 'CaptureError';
  constructor(message: string, cause?: unknown) {
    super(message, {cause});
    this.name = 'CaptureError';
  }
}
export interface StageOptions {
  readonly viewport: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly version: string;
  readonly onChange: (state: StageState) => void;
  readonly filename?: () => string;
  readonly beforeCapture?: () => boolean;
  /** The returned material is borrowed; its owner is the editor/texturing system. */
  readonly prepareMaterial?: (maxAnisotropy: number) => THREE.Material;
}
export interface StageSnapshot {
  readonly three: string;
  readonly specimen: SpecimenKind;
  readonly view: SurfaceView;
  readonly motion: boolean;
  readonly capturing: boolean;
  readonly renders: number;
  readonly triangles: number;
  readonly graphicsAvailable: boolean;
  readonly graphics: GraphicsState;
  readonly textures: number | null;
  readonly geometries: number | null;
  readonly programs: number | null;
}
export interface Stage {
  readonly state: StageState;
  readonly available: boolean;
  readonly maxAnisotropy: number;
  readonly invalidate: () => void;
  readonly setMaterial: (material: THREE.Material) => void;
  readonly selectSpecimen: (kind: SpecimenKind) => void;
  readonly setView: (view: SurfaceView) => void;
  readonly resetView: () => void;
  readonly setMotion: (motion: boolean) => void;
  readonly retry: (profile?: GraphicsProfile) => boolean;
  readonly capture: () => Effect.Effect<CapturedView | null, CaptureError>;
  readonly report: () => Record<string, unknown>;
  readonly snapshot: () => StageSnapshot;
  readonly dispose: () => void;
}

const own = <T extends {dispose(): void}>(acquire: () => T) => Effect.acquireRelease(
  Effect.sync(acquire), value => Effect.sync(() => value.dispose()),
);
const listen = (target: EventTarget, name: string, callback: EventListener) => Effect.acquireRelease(
  Effect.sync(() => {target.addEventListener(name, callback); return callback;}),
  listener => Effect.sync(() => target.removeEventListener(name, listener)),
);

/** Geometry, controls and GPU resources have scopes; Solid owns all UI rendering. */
function stageInScope(options: StageOptions, scope: Scope.Closeable) {
  return Effect.gen(function* () {
    const {canvas, viewport, version, onChange, prepareMaterial} = options;
    const filename = options.filename ?? (() => 'moonweave-surface');
    const beforeCapture = options.beforeCapture ?? (() => true);
    const document = canvas.ownerDocument;
    const window = document.defaultView!;
    let state = initialStageState;
    let graphics: GraphicsSession<THREE.WebGLRenderer> | undefined;
    let disposed = false, frame = 0, previousTime = 0, renders = 0;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(36, 1, .05, 80);
    const orbit = yield* own(() => new OrbitControls(camera, canvas));
    orbit.enableDamping = false; orbit.enablePan = false;
    orbit.minDistance = 3.6; orbit.maxDistance = 18;
    orbit.minPolarAngle = .12; orbit.maxPolarAngle = Math.PI * .83;
    orbit.rotateSpeed = .72; orbit.zoomSpeed = .75;
    scene.add(new THREE.HemisphereLight(0xb6d8e8, 0x263139, 1.5));
    const key = new THREE.DirectionalLight(0xe2f0e7, 3.2);
    key.position.set(-3.5, 5.5, 5); key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, {left: -4, right: 4, top: 4, bottom: -4, near: .5, far: 18});
    key.shadow.normalBias = .035; key.shadow.bias = -.0002;
    yield* own(() => key.shadow);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8ab8cc, 2.6); rim.position.set(2.4, 1.7, -3.8); scene.add(rim);
    const warm = new THREE.DirectionalLight(0xa397bc, .8); warm.position.set(3, 1, 3); scene.add(warm);
    const floorMaterial = yield* own(() => new THREE.ShadowMaterial({color: 0x000408, opacity: .34}));
    let floor: THREE.Mesh<THREE.CircleGeometry, THREE.ShadowMaterial> | null = null;
    const clay = yield* own(() => new THREE.MeshStandardMaterial({color: 0xaab3ad, roughness: .86, side: THREE.DoubleSide}));
    const normals = yield* own(() => new THREE.MeshNormalMaterial({side: THREE.DoubleSide}));
    let painted: THREE.Material = clay;
    const currentMaterial = () => state.view === 'clay' ? clay : state.view === 'normals' ? normals : painted;
    const acquireSpecimen = (kind: SpecimenKind) => own(() => {
      const next = createSpecimen(kind, currentMaterial());
      scene.add(next.group);
      return next;
    });
    const specimenRef = yield* ScopedRef.make<ReturnType<typeof createSpecimen> | null>(() => null);
    const specimen = () => ScopedRef.getUnsafe(specimenRef);
    const prepareGeometry = () => Effect.gen(function* () {
      if (!floor) {
        const geometry = yield* own(() => new THREE.CircleGeometry(6.5, 96));
        floor = new THREE.Mesh(geometry, floorMaterial);
        floor.rotation.x = -Math.PI / 2; floor.position.y = -1.76; floor.receiveShadow = true;
        scene.add(floor);
      }
      if (specimen()?.kind !== state.specimen) yield* ScopedRef.set(specimenRef, acquireSpecimen(state.specimen));
    }).pipe(Scope.provide(scope));
    function update(fields: Partial<StageState>) {
      state = {...state, ...fields};
      if (!disposed) onChange(state);
    }
    function invalidate() {
      if (!disposed && graphics?.canRender && !frame && !document.hidden) frame = window.requestAnimationFrame(draw);
    }
    function draw(time = 0) {
      frame = 0;
      if (disposed || document.hidden || !graphics?.canRender) return;
      const dt = Math.min((time - previousTime) / 1000 || 0, .05); previousTime = time;
      if (state.motion) specimen()!.group.rotation.y += dt * .18;
      if (graphics.render(scene, camera)) renders++;
      if (state.motion) invalidate();
    }
    function graphicsChanged(next: GraphicsState) {
      if (disposed) {update({graphics: next, motion: false, capturing: false}); return;}
      const ready = next.status === 'ready';
      orbit.enabled = ready;
      if (!ready) {window.cancelAnimationFrame(frame); frame = 0;}
      update({graphics: next, ...(!ready ? {motion: false, capturing: false} : {})});
      if (next.status === 'starting') invalidate();
    }
    function setMaterial(material: THREE.Material) {
      painted = material;
      specimen()?.group.traverse(object => {if (object instanceof THREE.Mesh) object.material = currentMaterial();});
      invalidate();
    }
    function prepareRenderer(renderer: THREE.WebGLRenderer, profile: GraphicsProfile) {
      return Effect.gen(function* () {
        const reduced = profile === 'reduced';
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, reduced ? 1 : 1.75));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.18;
        renderer.shadowMap.enabled = !reduced;
        renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        // CPU geometry belongs to the stage, and is built only after WebGL succeeds.
        // Retrying a renderer reuses it; offline selection chooses what to build next.
        yield* prepareGeometry();
        // Shadow targets are created lazily by render, but belong to this renderer attempt.
        yield* Effect.acquireRelease(Effect.succeed(key.shadow), shadow => Effect.sync(() => {
          const target = shadow.map;
          shadow.map = null;
          target?.dispose();
        }));
        if (!reduced) {
          const rendererScope = yield* Effect.scope;
          yield* Effect.scoped(Effect.gen(function* () {
            const pmrem = yield* own(() => new THREE.PMREMGenerator(renderer));
            const room = yield* own(() => new RoomEnvironment());
            // The generated target survives the temporary generator/room scope.
            const environment = yield* Effect.acquireRelease(
              Effect.sync(() => pmrem.fromScene(room, .08)),
              target => Effect.sync(() => {scene.environment = null; target.dispose();}),
            ).pipe(Scope.provide(rendererScope));
            scene.environment = environment.texture; scene.environmentIntensity = .48;
          }));
        }
        const width = viewport.clientWidth, height = viewport.clientHeight;
        if (width && height) renderer.setSize(width, height, false);
        if (prepareMaterial) setMaterial(prepareMaterial(Math.min(4, renderer.capabilities.getMaxAnisotropy())));
      });
    }
    graphics = yield* acquireGraphicsSession({
      canvas, createRenderer: context => new THREE.WebGLRenderer({canvas, context}),
      prepare: prepareRenderer, onChange: graphicsChanged,
    });
    const session = graphics;
    function selectSpecimen(kind: SpecimenKind) {
      if (kind === state.specimen) return;
      if (session.canRender) Effect.runSync(ScopedRef.set(specimenRef, acquireSpecimen(kind)));
      update({specimen: kind}); invalidate();
    }
    function setView(view: SurfaceView) {
      update({view}); setMaterial(painted);
      if (session.state.status === 'failed') session.start();
    }
    function resetView() {
      specimen()?.group.rotation.set(0, 0, 0);
      camera.position.set(5.1, 2.3, 7.9); orbit.target.set(0, .05, 0); orbit.update(); invalidate();
    }
    function setMotion(motion: boolean) {
      update({motion: session.available && motion});
      previousTime = window.performance.now(); invalidate();
    }
    function resize() {
      const width = viewport.clientWidth, height = viewport.clientHeight;
      if (!width || !height) return;
      if (session.canRender) session.renderer?.setSize(width, height, false);
      camera.aspect = width / height; camera.updateProjectionMatrix(); invalidate();
    }
    function capture(): Effect.Effect<CapturedView | null, CaptureError> {
      return Effect.suspend(() => {
        if (!session.available || state.capturing) return Effect.succeed(null);
        return Effect.acquireUseRelease(
          Effect.sync(() => update({capturing: true})),
          () => session.whileReady(Effect.gen(function* () {
            const name = yield* Effect.try({
              try: () => {
                if (!beforeCapture() || !session.render(scene, camera)) return null;
                renders++;
                return `${filename()}-${state.specimen}.png`;
              },
              catch: cause => new CaptureError(cause instanceof Error ? cause.message : String(cause), cause),
            });
            if (!name) return null;
            const blob = yield* Effect.callback<Blob, CaptureError>(resume => {
              // Encoding cannot be aborted, but a canceled fiber cannot deliver its stale result.
              try {
                canvas.toBlob(value => resume(value
                  ? Effect.succeed(value)
                  : Effect.fail(new CaptureError('The browser could not capture this view.'))));
              } catch (cause) {
                resume(Effect.fail(new CaptureError(cause instanceof Error ? cause.message : String(cause), cause)));
              }
            });
            return {blob, filename: name};
          })),
          () => Effect.sync(() => update({capturing: false})),
        );
      });
    }
    function report(): Record<string, unknown> {
      const renderer = session.renderer, context = renderer?.getContext();
      const usable = context && !context.isContextLost();
      return {
        moonweave: version, three: THREE.REVISION, browser: window.navigator.userAgent,
        webgl2API: typeof WebGL2RenderingContext !== 'undefined',
        ...session.state,
        context: usable ? {
          version: context.getParameter(context.VERSION),
          shadingLanguage: context.getParameter(context.SHADING_LANGUAGE_VERSION),
          vendor: context.getParameter(context.VENDOR), renderer: context.getParameter(context.RENDERER),
          maxTextureSize: context.getParameter(context.MAX_TEXTURE_SIZE),
          maxTextureUnits: context.getParameter(context.MAX_TEXTURE_IMAGE_UNITS),
          attributes: context.getContextAttributes(),
        } : null,
        preview: {width: viewport.clientWidth, height: viewport.clientHeight, pixelRatio: renderer?.getPixelRatio() ?? null, renders},
      };
    }
    yield* listen(canvas, 'keydown', event => {
      const key = event as KeyboardEvent;
      const polar = new THREE.Spherical().setFromVector3(camera.position.clone().sub(orbit.target));
      if (key.key === 'ArrowLeft') polar.theta -= .08;
      else if (key.key === 'ArrowRight') polar.theta += .08;
      else if (key.key === 'ArrowUp') polar.phi -= .08;
      else if (key.key === 'ArrowDown') polar.phi += .08;
      else if (['+', '='].includes(key.key)) polar.radius *= .9;
      else if (key.key === '-') polar.radius *= 1.1;
      else return;
      key.preventDefault(); polar.phi = THREE.MathUtils.clamp(polar.phi, orbit.minPolarAngle, orbit.maxPolarAngle);
      polar.radius = THREE.MathUtils.clamp(polar.radius, orbit.minDistance, orbit.maxDistance);
      camera.position.setFromSpherical(polar).add(orbit.target); orbit.update(); invalidate();
    });
    const observer = yield* Effect.acquireRelease(
      Effect.sync(() => new ResizeObserver(resize)), observer => Effect.sync(() => observer.disconnect()),
    );
    observer.observe(viewport);
    yield* Effect.acquireRelease(
      Effect.sync(() => orbit.addEventListener('change', invalidate)),
      () => Effect.sync(() => orbit.removeEventListener('change', invalidate)),
    );
    yield* listen(document, 'visibilitychange', () => {previousTime = window.performance.now(); invalidate();});
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      disposed = true;
      window.cancelAnimationFrame(frame); frame = 0;
      update({motion: false, capturing: false});
    }));
    resetView(); resize(); session.start();
    return {
      get state() {return state;},
      get available() {return session.available;},
      get maxAnisotropy() {return session.canRender ? Math.min(4, session.renderer!.capabilities.getMaxAnisotropy()) : 1;},
      invalidate, setMaterial, selectSpecimen, setView, resetView, setMotion, capture, report,
      retry: (profile?: GraphicsProfile) => session.start(profile),
      snapshot: (): StageSnapshot => ({
        three: THREE.REVISION, specimen: state.specimen, view: state.view, motion: state.motion, capturing: state.capturing,
        renders, triangles: specimen()?.triangles ?? 0, graphicsAvailable: session.available, graphics: session.state,
        textures: session.renderer?.info.memory.textures ?? null, geometries: session.renderer?.info.memory.geometries ?? null,
        programs: session.renderer?.info.programs?.length ?? null,
      }),
      dispose: () => Effect.runSync(Scope.close(scope, Exit.void)),
    } satisfies Stage;
  }).pipe(Scope.provide(scope));
}

/** The only imperative bridge: Solid opens this scope on mount and closes it on cleanup. */
export function createStage(options: StageOptions): Stage {
  const scope = Effect.runSync(Scope.make());
  return Effect.runSync(stageInScope(options, scope).pipe(Effect.tapCause(cause => Scope.close(scope, Exit.failCause(cause)))));
}
