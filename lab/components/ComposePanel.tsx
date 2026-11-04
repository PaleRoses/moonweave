import {createFieldSampler} from '@moonweave/surfaces/core';
import {displayHex} from './ColorControls';
import {createMemo, For, Show} from 'solid-js';
import type {PaintView} from '../composition.mts';
import type {Editor, ExampleName, RegionMode} from '../editor';
import {COMPOSITION_EXAMPLES} from '../examples.mts';
import {ExpressionControl} from './ExpressionControl';
import {FieldApplications} from './FieldApplications';

const EXAMPLE_IDS = Object.keys(COMPOSITION_EXAMPLES) as ExampleName[];

export function ComposePanel(props: {editor: Editor; onPaint: () => void}) {
  const editor = props.editor;
  const swatch = (paint: PaintView) => {
    const sample = createFieldSampler(editor.graph(), {
      base: {id: paint.palette.base, sort: 'color'},
      shadow: {id: paint.palette.shadow, sort: 'color'},
      light: {id: paint.palette.light, sort: 'color'},
    })({position: [0, 0, 0]});
    return `linear-gradient(145deg, ${displayHex(sample.light.value)}, ${displayHex(sample.base.value)} 45%, ${displayHex(sample.shadow.value)})`;
  };
  const surfaceControls = createMemo(() => {
    const primary: string[] = [], construction: string[] = [], index = editor.index();
    for (const id of editor.surfaceControlIds()) {
      const kind = index.byId.get(id)?.kind;
      (kind === 'ramp' || kind === 'facing' || kind === 'noise' || kind === 'transform' ? construction : primary).push(id);
    }
    return {primary, construction};
  });
  const blendInputs = createMemo(() => {
    const blend = editor.mask()?.blend;
    if (!blend) return '';
    return blend.a === blend.b
      ? `Both inputs reference ${editor.surfaceLabel(blend.a)}. This mask does not change that surface.`
      : `First: ${editor.surfaceLabel(blend.a)} · Second: ${editor.surfaceLabel(blend.b)}`;
  });
  return <section id="compose-panel" aria-labelledby="composition-title" hidden={editor.tab() !== 'compose'}>
    <div class="section-heading"><h3 id="composition-title">Surface composition</h3><span id="graph-state">{editor.liveSources().length} source{editor.liveSources().length === 1 ? '' : 's'}</span></div>
    <p class="section-copy">Compose paint and procedural color. Share fields to connect color, regions and finish.</p>
    <div id="layer-list" class="layer-list" role="group" aria-label="Surface sources">
      <For each={editor.paintIds()}>{id => <Show when={editor.paintById().get(id)}>{paint =>
        <div class="layer-row" classList={{active: editor.selectedPaint() === id}}>
          <button class="layer-select" aria-pressed={editor.selectedPaint() === id} onClick={() => editor.selectPaint(id)}>
            <span class="layer-swatch" style={{background: swatch(paint())}}/>
            <span><strong>{paint().label}</strong><small>{editor.index().live.has(id) ? '' : 'UNUSED · '}{id}</small></span>
          </button>
        </div>
      }</Show>}</For>
      <For each={editor.index().sources.filter(node => node.kind === 'material')}>{source => <div class="layer-row material-source">
        <div class="layer-select"><span class="layer-swatch material-swatch" aria-hidden="true">◈</span>
          <span><strong>Color material</strong><small>{editor.index().live.has(source.id) ? '' : 'UNUSED · '}{source.id}</small></span>
        </div>
      </div>}</For>
    </div>
    <button id="add-layer" class="wide-button" onClick={editor.addPaint}><span aria-hidden="true">+</span> {editor.paintIds().length ? 'Add another paint' : 'Add a paint'}</button>
    <div id="blend-controls" hidden={!editor.selectedBlend()}>
      <div class="control-section"><div class="section-heading"><h3>Where surfaces meet</h3><span id="blend-count">{editor.blendIds().length} BLEND{editor.blendIds().length === 1 ? '' : 'S'}</span></div>
        <label class="select-control" for="blend-target"><span>Editing blend</span><select id="blend-target"
          onChange={event => editor.selectBlend(event.currentTarget.value)}>
          <For each={editor.blendIds()}>{(id, position) => <option value={id} selected={editor.selectedBlend() === id}>Blend {position() + 1} · {id}{editor.index().live.has(id) ? '' : ' · unused'}</option>}</For>
        </select></label>
        <p id="blend-inputs" class="section-copy">{blendInputs()}</p>
        <label class="select-control" for="mask-mode"><span>Region</span><select id="mask-mode" value={editor.mask()?.mode ?? 'uniform'}
          onChange={event => editor.setRegion(event.currentTarget.value as RegionMode)}>
          <option value="height">Position</option><option value="facing">Surface direction</option><option value="uniform">Uniform amount</option><option value="custom" disabled>Custom expression</option>
        </select></label>
        <p id="mask-description" class="section-copy">{editor.mask()?.mode === 'custom'
          ? 'Edit this expression’s values below. Choosing a region replaces its custom expression.'
          : 'Position and surface direction keep the same strength, boundary, and reversals. Uniform amount removes the region.'}</p>
        <div id="mask-controls" aria-label="Mask values"><For each={editor.maskControlIds()}>{id => <ExpressionControl editor={editor} id={id}/>}</For></div>
        <div class="blend-actions"><button id="reverse-mask" onClick={editor.reverseMask}>Reverse whole mask</button><button id="remove-blend" onClick={editor.removeBlend}>Remove blend</button></div>
        <p class="section-copy">Reversal swaps the two surface weights after strength is applied.</p>
        <p class="section-copy blend-removal-note">Removing this blend keeps its first surface.</p>
      </div>
    </div>
    <FieldApplications editor={editor}/>
    <Show when={editor.surfaceControlIds().length > 0}>
      <section id="surface-parameters" class="control-section" aria-labelledby="surface-parameters-title">
        <div class="section-heading"><h3 id="surface-parameters-title">Surface controls</h3><span>EXPOSED VALUES</span></div>
        <p class="section-copy">Tune color, variation, coordinates and finish. Shared controls change every place they are used.</p>
        <For each={surfaceControls().primary}>{id => <ExpressionControl editor={editor} id={id}/>}</For>
        <Show when={surfaceControls().construction.length > 0}>
          <details class="field-construction">
            <summary>Field construction <span>{surfaceControls().construction.length} controls</span></summary>
            <p class="section-copy">Shape masks, transitions, grain and coordinates. These fields feed the colors and surface values above.</p>
            <For each={surfaceControls().construction}>{id => <ExpressionControl editor={editor} id={id}/>}</For>
          </details>
        </Show>
      </section>
    </Show>
    <Show when={editor.chosenPaint()}><button id="edit-selected-paint" class="wide-button edit-paint" onClick={props.onPaint}>Edit selected paint <span aria-hidden="true">→</span></button></Show>
    <div class="composition-examples"><p class="eyebrow">START WITH A RELATIONSHIP</p><div><For each={EXAMPLE_IDS}>{id =>
      <button data-example={id} onClick={() => editor.useExample(id)}>{COMPOSITION_EXAMPLES[id].label}</button>
    }</For></div></div>
  </section>;
}
