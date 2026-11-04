import {createEffect, createMemo, createSignal, For} from 'solid-js';
import type {Accessor} from 'solid-js';
import {graphicsMessage, SPECIMENS} from '../stage';
import type {GraphicsProfile, SpecimenKind, Stage, StageState, SurfaceView} from '../stage';
import type {Editor} from '../editor';

const SPECIMEN_IDS = Object.keys(SPECIMENS) as SpecimenKind[];
const VIEWS: readonly {id: SurfaceView; label: string}[] = [
  {id: 'painted', label: 'Painted'}, {id: 'clay', label: 'Clay'}, {id: 'normals', label: 'Normals'},
];
interface StagePreviewProps {
  editor: Editor;
  stage: Accessor<Stage | null>;
  state: Accessor<StageState>;
  viewport(element: HTMLDivElement): void;
  canvas(element: HTMLCanvasElement): void;
  inspect(): void;
  capture(): void;
  retry(profile?: GraphicsProfile): void;
  copyReport(report: string): void;
}

export function StagePreview(props: StagePreviewProps) {
  const editor = props.editor;
  const [reportOpen, setReportOpen] = createSignal(false);
  const [report, setReport] = createSignal('Open these details to inspect the preview status.');
  const graphics = () => props.state().graphics;
  const ready = () => graphics().status === 'ready';
  const starting = () => graphics().status === 'starting' || graphics().status === 'idle';
  const unavailable = () => ['unavailable', 'failed', 'lost'].includes(graphics().status);
  const retryDisabled = () => starting() || graphics().status === 'lost';
  const recoveryCopy = createMemo(() => graphicsMessage(graphics()));
  const resourceNote = createMemo(() => {
    if (ready()) {
      const cost = editor.plan().cost;
      return `${cost.paintSamples} sampled field${cost.paintSamples === 1 ? '' : 's'} · ${editor.filteredImages() ? '≤ ' : ''}${cost.textureReads} texture reads${graphics().profile === 'reduced' ? ' · reduced lighting' : ''}`;
    }
    return starting() ? 'Starting live preview…' : 'Reference image · composition editor active';
  });
  function refreshReport() {
    const stage = props.stage();
    const text = stage ? JSON.stringify(stage.report(), null, 2) : 'The preview has not started.';
    setReport(text); return text;
  }
  createEffect(() => {
    props.state();
    if (reportOpen()) refreshReport();
  });
  return <div class="stage-column">
    <div class="stage-bar"><div class="specimen-tabs" role="group" aria-label="Specimen shape">
      <For each={SPECIMEN_IDS}>{id => <button classList={{active: props.state().specimen === id}} aria-pressed={props.state().specimen === id}
        onClick={() => props.stage()?.selectSpecimen(id)}>{SPECIMENS[id].label}</button>}</For>
    </div><button id="reset-view" class="icon-button" title="Reset view" aria-label="Reset view" disabled={!ready()} onClick={() => props.stage()?.resetView()}>↺</button></div>
    <div id="viewport" class="viewport" classList={{'graphics-unavailable': unavailable()}} ref={props.viewport} aria-label="Interactive three dimensional material specimen">
      <canvas id="canvas" ref={props.canvas} hidden={!ready()} tabindex="0" aria-label="Material specimen. Drag to orbit; scroll to zoom. Arrow keys orbit; plus and minus zoom."/>
      <div class="stage-title"><span id="specimen-number">{SPECIMENS[props.state().specimen].number} / FORM STUDY</span><h2 id="preset-title">{editor.title()}</h2><p id="preset-description">{editor.description()}</p></div>
      <div class="stage-tools"><button id="motion" aria-pressed={props.state().motion} disabled={!ready()}
        onClick={() => props.stage()?.setMotion(!props.state().motion)}><span aria-hidden="true">{props.state().motion ? 'Ⅱ' : '▷'}</span> {props.state().motion ? 'Pause' : 'Turntable'}</button>
        <button id="capture" title="Save the current view as a PNG" disabled={!ready() || props.state().capturing} onClick={props.capture}>Save view <span aria-hidden="true">↓</span></button>
      </div>
      <div id="loading" class="loading" role="status" hidden={!starting()}><span/> Preparing pigment</div>
      <div class="graphics-fallback">
        <figure id="graphics-reference" class="graphics-reference" hidden={!unavailable()}>
          <span class="eyebrow">REFERENCE IMAGE</span>
          <img src="./docs/evidence/shell-shared-near.png" width="512" height="512" alt="Reference render of blue faceted carapace plates fading to a pale underside."/>
          <figcaption>Reference render · pale underside on carapace. This image does not update with your edits.</figcaption>
        </figure>
        <div id="render-error" class="render-error" hidden={!unavailable()} role="alert" aria-labelledby="graphics-title" aria-describedby="graphics-message">
          <h3 id="graphics-title">{recoveryCopy().title}</h3><p id="graphics-message">{recoveryCopy().message}</p>
          <div id="graphics-actions" class="graphics-actions">
            <button id="retry-graphics" class="primary" disabled={retryDisabled()} onClick={() => props.retry()}>Retry preview</button>
            <button id="reduce-graphics" disabled={retryDisabled() || graphics().profile === 'reduced'} onClick={() => props.retry('reduced')}>Try reduced load</button>
          </div>
          <a class="graphics-help" href="./guide.html#graphics" target="_blank" rel="noopener">Graphics help <span aria-hidden="true">↗</span></a>
        </div>
      </div>
      <div class="stage-bottom"><span id="specimen-subtitle">{SPECIMENS[props.state().specimen].subtitle}</span><span>DRAG TO ORBIT <b>·</b> SCROLL TO APPROACH</span></div>
    </div>
    <div class="view-strip"><div role="group" aria-label="Surface inspection"><For each={VIEWS}>{view =>
      <button data-view={view.id} classList={{active: props.state().view === view.id}} aria-pressed={props.state().view === view.id}
        disabled={!ready() && graphics().status !== 'failed'} onClick={() => props.stage()?.setView(view.id)}>{view.label}</button>
    }</For></div><span id="resource-note">{resourceNote()}</span></div>
    <div class="composition-readout"><div><span class="eyebrow">THE CURRENT SURFACE</span><p id="composition-expression">{editor.expression()}</p></div>
      <button id="inspect-graph" aria-controls="graph-panel" onClick={props.inspect}>Inspect graph <span aria-hidden="true">↓</span></button>
    </div>
    <details id="graphics-details" class="graphics-details" onToggle={event => setReportOpen(event.currentTarget.open)}>
      <summary>Graphics details</summary><div class="graphics-details-body">
        <p>Preview status and browser graphics support. No surface graph data is included.</p>
        <pre id="graphics-report" tabindex="0" aria-label="Graphics diagnostic report">{report()}</pre>
        <p>Reduced load caps the pixel ratio at 1 and turns off shadows and environment lighting. It cannot enable graphics blocked by your browser.</p>
        <div class="graphics-actions"><button id="copy-graphics-report" onClick={() => props.copyReport(refreshReport())}>Copy graphics report</button>
          <button id="quality-graphics" disabled={retryDisabled()} onClick={() => props.retry(graphics().profile === 'reduced' ? 'standard' : 'reduced')}>
            {graphics().profile === 'reduced' ? 'Use full lighting' : 'Use reduced load'}
          </button>
        </div>
      </div>
    </details>
  </div>;
}
