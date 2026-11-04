import {
  DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping, LinearFilter,
  FloatType, NearestFilter, ClampToEdgeWrapping,
  LinearMipmapLinearFilter, NoColorSpace, MeshPhysicalMaterial,
  Vector2, Vector3, Vector4, Matrix3, Matrix4, FrontSide, BackSide, DoubleSide,
} from 'three';
import * as Effect from 'effect/Effect';
import {createEffect, createSignal, on, onCleanup, onMount} from 'solid-js';
import {render} from 'solid-js/web';
import {compileGraph} from '@moonweave/surfaces/core';
import {createTexturingSystem} from '@moonweave/surfaces/three';
import {validateSurfaceShaderPlan} from '../src/three/shader.mjs';
import type {GraphPlan, MaterialGraph} from '@moonweave/surfaces/core';
import type {MaterialHandle, TexturingSystem, TexturingEngine} from '@moonweave/surfaces/three';
import {createEditor} from './editor';
import type {EditorTab} from './editor';
import {copyText, downloadBlob, downloadText, readSurfaceFile} from './editor-io.mts';
import {createStage, initialStageState} from './stage';
import type {GraphicsProfile, Stage, StageState} from './stage';
import {ComposePanel} from './components/ComposePanel';
import {PaintPanel} from './components/PaintPanel';
import {SourcePanel} from './components/SourcePanel';
import {StagePreview} from './components/StagePreview';
import {createSessionStore} from './session.mts';
import type {SaveStatus} from './session.mts';
import './style.css';

const texturingEngine = {
  DataTexture, RGBAFormat, UnsignedByteType, RepeatWrapping, LinearFilter,
  FloatType, NearestFilter, ClampToEdgeWrapping,
  LinearMipmapLinearFilter, NoColorSpace, MeshPhysicalMaterial,
  Vector2, Vector3, Vector4, Matrix3, Matrix4, FrontSide, BackSide, DoubleSide,
} satisfies TexturingEngine;

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function Atelier() {
  const [stage, setStage] = createSignal<Stage | null>(null);
  const [stageState, setStageState] = createSignal<StageState>(initialStageState);
  const [importing, setImporting] = createSignal(false);
  const [saveStatus, setSaveStatus] = createSignal<SaveStatus>('idle');
  const session = createSessionStore({
    status: setSaveStatus,
    accept: graph => validateSurfaceShaderPlan(compileGraph(graph)),
  });
  const restored = session.load();
  const io = new AbortController();
  let viewport!: HTMLDivElement, canvas!: HTMLCanvasElement;
  let inspector!: HTMLElement, sourcePanel!: HTMLDetailsElement;
  let system: TexturingSystem | null = null, handle: MaterialHandle | null = null, transparent = false;
  let validatedStructure: GraphPlan['structure'] | null = null;

  function commitMaterial(graph: MaterialGraph, plan: GraphPlan) {
    if (plan.structure !== validatedStructure) {
      validateSurfaceShaderPlan(plan);
      validatedStructure = plan.structure;
    }
    if (!system || !handle) return;
    const nextTransparent = plan.opacityRange[0] < 1;
    if (nextTransparent === transparent) handle.setGraph(graph);
    else {
      const replacement = system.createMaterial(graph, {coordinates: 'attribute', transparent: nextTransparent});
      const previous = handle; handle = replacement; transparent = nextTransparent;
      stage()?.setMaterial(replacement.material); previous.dispose();
    }
  }
  const editor = createEditor({initial: restored, commit: commitMaterial, invalidate: () => stage()?.invalidate()});
  let observedSession = editor.session();
  createEffect(on(editor.session, next => {
    observedSession = next; session.schedule(next);
  }, {defer: true}));

  function checkpoint() {
    editor.gestureEnd();
    const next = editor.session();
    if (next !== observedSession) { observedSession = next; session.schedule(next); }
    session.flush();
  }
  function visibilityChanged() { if (document.visibilityState === 'hidden') checkpoint(); }
  function historyKey(event: KeyboardEvent) {
    if (event.defaultPrevented || event.altKey || !(event.metaKey || event.ctrlKey)) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    event.preventDefault();
    if (key === 'y' || event.shiftKey) editor.redo(); else editor.undo();
  }

  /** No atlas or adapter exists until the browser has a usable renderer. */
  function prepareMaterial(anisotropy: number) {
    system ??= createTexturingSystem(texturingEngine, {anisotropy});
    if (!handle) {
      transparent = editor.plan().opacityRange[0] < 1;
      handle = system.createMaterial(editor.graph(), {coordinates: 'attribute', transparent});
    }
    return handle.material;
  }
  function startStage(profile?: GraphicsProfile) {
    const current = stage();
    if (current) { current.retry(profile); return; }
    try {
      const created = createStage({
        viewport, canvas,
        version: document.querySelector<HTMLMetaElement>('meta[name="moonweave-version"]')?.content ?? 'unknown',
        onChange: setStageState, beforeCapture: editor.flush, prepareMaterial,
        filename: () => 'moonweave-surface',
      });
      setStage(created);
      if (profile && profile !== initialStageState.graphics.profile) created.retry(profile);
    } catch (error) {
      setStageState({...initialStageState, graphics: {...initialStageState.graphics, status: 'failed', phase: 'prepare', error: {name: 'InitializationError', message: message(error)}}});
      editor.tell(message(error), true);
    }
  }
  function run<A, E extends {readonly message: string}>(operation: Effect.Effect<A, E>, success: (value: A) => void, failure?: (error: E) => void) {
    const handled = Effect.match(operation, {
      onFailure: failure ?? (error => editor.tell(error.message, true)),
      onSuccess: success,
    });
    void Effect.runPromise(handled, {signal: io.signal}).catch(error => {
      if (!io.signal.aborted) editor.tell(message(error), true);
    });
  }
  function capture() {
    const current = stage();
    if (!current || !editor.flush()) return;
    run(Effect.flatMap(current.capture(), result => result
      ? Effect.map(downloadBlob(result.blob, result.filename), () => true) : Effect.succeed(false)),
    requested => { if (requested) editor.tell('View download requested.'); });
  }
  function exportGraph() {
    if (!editor.flush()) return;
    run(downloadText(editor.acceptedSource(), 'moonweave-surface-graph.json'), () => editor.tell('Graph download requested.'));
  }
  function importGraph(file: File) {
    if (!editor.flush()) return;
    setImporting(true);
    run(readSurfaceFile(file), source => { setImporting(false); editor.importSource(source); },
      error => { setImporting(false); editor.tell(error.message, true); });
  }
  function showTab(tab: EditorTab) {
    if (editor.showTab(tab)) inspector.scrollTop = 0;
  }
  function inspectGraph() {
    if (editor.openSource()) sourcePanel.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start'});
  }

  onMount(() => {
    window.addEventListener('keydown', historyKey);
    window.addEventListener('pagehide', checkpoint);
    document.addEventListener('visibilitychange', visibilityChanged);
    startStage();
    Object.defineProperty(window, 'moonweaveLab', {configurable: true, value: Object.freeze({snapshot: () => Object.freeze({
      ...stage()?.snapshot(), graph: editor.graph(), selectedPaint: editor.selectedPaint(), selectedBlend: editor.selectedBlend(),
      editor: editor.tab(), cost: editor.plan().cost, programKey: editor.plan().programKey,
      sourceDirty: editor.sourceDirty(), ...editor.metrics(), materialVersion: handle?.material.version ?? null,
      atlasBytes: system?.fields.bytes ?? 0,
    })})});
  });
  onCleanup(() => {
    checkpoint(); session.dispose();
    window.removeEventListener('keydown', historyKey);
    window.removeEventListener('pagehide', checkpoint);
    document.removeEventListener('visibilitychange', visibilityChanged);
    io.abort(); editor.dispose();
    try { stage()?.dispose(); } finally { system?.dispose(); }
    Reflect.deleteProperty(window, 'moonweaveLab');
  });

  return <>
    <section id="atelier" class="atelier" aria-label="Interactive material atelier">
      <StagePreview editor={editor} stage={stage} state={stageState} viewport={element => viewport = element} canvas={element => canvas = element}
        inspect={inspectGraph} capture={capture} retry={startStage}
        copyReport={text => run(copyText(text), () => editor.tell('Graphics report copied.'), () => editor.tell('Select the graphics report and copy it with your browser’s copy command.'))}/>
      <aside class="inspector" ref={inspector} aria-label="Surface controls">
        <div class="inspector-tabs" role="group" aria-label="Editor section">
          <button data-editor="compose" classList={{active: editor.tab() === 'compose'}} aria-pressed={editor.tab() === 'compose'} onClick={() => showTab('compose')}>Compose</button>
          <button data-editor="paint" classList={{active: editor.tab() === 'paint'}} aria-pressed={editor.tab() === 'paint'} onClick={() => showTab('paint')}>Paint</button>
        </div>
        <div class="history-toolbar">
          <div role="group" aria-label="Edit history">
            <button id="undo-edit" disabled={!editor.canUndo()} title={`${editor.undoLabel() ? `Undo: ${editor.undoLabel()}` : 'Undo'} (⌘/Ctrl+Z)`} onClick={editor.undo}><span aria-hidden="true">↶</span> Undo</button>
            <button id="redo-edit" disabled={!editor.canRedo()} title={`${editor.redoLabel() ? `Redo: ${editor.redoLabel()}` : 'Redo'} (⌘/Ctrl+Shift+Z)`} onClick={editor.redo}><span aria-hidden="true">↷</span> Redo</button>
          </div>
          <span id="save-state" classList={{'save-unavailable': saveStatus() === 'unavailable'}} role="status"
            title={saveStatus() === 'unavailable' ? 'Local save is unavailable. Export the graph to keep this surface.' : 'Your surface and source draft are kept in this browser.'}>
            {saveStatus() === 'pending' ? 'Saving…' : saveStatus() === 'saved' ? 'Saved in this browser' : saveStatus() === 'unavailable' ? 'Local save unavailable' : 'Autosave on'}
          </span>
        </div>
        <ComposePanel editor={editor} onPaint={() => showTab('paint')}/>
        <PaintPanel editor={editor}/>
        <div class="inspector-actions"><div class="recipe-actions">
          <button id="reset-recipe" onClick={editor.reset}>Reset surface</button>
          <button id="export-recipe" class="primary" onClick={exportGraph}>Export graph <span aria-hidden="true">↓</span></button>
        </div>
          <label class="import-label">{importing() ? 'Reading surface…' : 'Bring a surface back'}
            <input id="import-recipe" type="file" accept="application/json,.json" disabled={importing()} onChange={event => {
              const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
              if (file) importGraph(file);
            }}/><span aria-hidden="true">↗</span>
          </label>
          <p id="notice" class="notice" classList={{error: editor.notice().error}} role="status" aria-live="polite">{editor.notice().message}</p>
        </div>
      </aside>
    </section>
    <SourcePanel editor={editor} register={element => sourcePanel = element}
      copy={(text, fallback) => run(copyText(text), () => editor.sourceFeedback('Graph JSON copied.'), fallback)}/>
  </>;
}

const mount = document.getElementById('atelier-app');
if (!mount) throw new Error('The atelier mount is missing.');
const dispose = render(() => <Atelier/>, mount);
function leave(event: PageTransitionEvent) {
  if (!event.persisted) { dispose(); window.removeEventListener('pagehide', leave); }
}
window.addEventListener('pagehide', leave);
