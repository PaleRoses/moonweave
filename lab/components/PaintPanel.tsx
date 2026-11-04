import {createMemo, For, Show} from 'solid-js';
import {PALETTE_KEYS, SURFACE_PRESETS, createFieldSampler} from '@moonweave/surfaces/core';
import type {SurfacePreset} from '@moonweave/surfaces/core';
import type {Editor} from '../editor';
import type {PaintView} from '../composition.mts';
import {NumberInput, RangeControl} from './Controls';
import {colorSources} from '../color-authoring.mts';
import {ColorChip, displayHex, LinearColorValues} from './ColorControls';

const PAINT_CONTROLS = [
  {key: 'contrast', target: 'style', label: 'Facet contrast', group: 'pigment', min: 0, max: 1, step: .01},
  {key: 'wash', target: 'style', label: 'Underpainting', group: 'pigment', min: 0, max: 1, step: .01},
  {key: 'marks', target: 'style', label: 'Selective marks', group: 'pigment', min: 0, max: 1, step: .01},
  {key: 'quiet', target: 'style', label: 'Quiet space', group: 'pigment', min: 0, max: 1, step: .01},
  {key: 'scale', target: 'mapping', label: 'Mark scale', group: 'surface', min: .035, max: .65, step: .005},
  {key: 'rotation', target: 'mapping', label: 'Paint direction', group: 'surface', min: 0, max: 360, step: 1},
  {key: 'relief', target: 'style', label: 'Facet relief', group: 'surface', min: 0, max: 1, step: .01},
  {key: 'roughness', target: 'style', label: 'Roughness', group: 'surface', min: 0, max: 1, step: .01},
] as const;
const PRESETS = Object.keys(SURFACE_PRESETS) as SurfacePreset[];
const PALETTE_LABELS = {base: {label: 'Body', accessible: 'Base pigment'}, shadow: {label: 'Depth', accessible: 'Shadow pigment'}, light: {label: 'Light', accessible: 'Light pigment'}};
const COLORS = PALETTE_KEYS.map(key => ({key, ...PALETTE_LABELS[key]}));

function PaintControls(props: {editor: Editor; paint: PaintView; group: 'pigment' | 'surface'}) {
  return <For each={PAINT_CONTROLS.filter(control => control.group === props.group)}>{control =>
    <RangeControl id={`control-${control.key}`} label={control.label}
      value={control.target === 'mapping' ? props.paint.mapping[control.key] : props.paint.style[control.key]}
      min={control.min} max={control.max} step={control.step}
      format={control.key === 'rotation' ? value => `${Math.round(value)}°` : undefined}
      onInput={value => control.target === 'mapping' ? props.editor.queueMapping({[control.key]: value}) : props.editor.queueStyle({[control.key]: value})} onCommit={props.editor.gestureEnd}/>
  }</For>;
}

export function PaintPanel(props: {editor: Editor}) {
  const editor = props.editor;
  return <section id="paint-panel" aria-labelledby="paint-title" hidden={editor.tab() !== 'paint'}>
    <div class="section-heading"><h3 id="paint-title">Paint library</h3><span id="recipe-state">{editor.edited() ? 'Edited' : 'Original'}</span></div>
    <Show when={editor.chosenPaint()} fallback={<div id="paint-empty">
      <p class="section-copy">This surface is built from color and procedural fields. Its values are in Compose.</p>
      <button id="add-first-paint" class="wide-button" onClick={editor.addPaint}>Add a paint to this surface</button>
    </div>}>{paint => {
      const fieldUsers = () => editor.index().fieldUsers.get(paint().mapping.id)?.length ?? 0;
      const sources = createMemo(() => colorSources(editor.graph(), paint().id));
      return <>
    <label class="select-control paint-target" for="paint-target"><span>Editing</span><select id="paint-target"
      onChange={event => editor.selectPaint(event.currentTarget.value)}>
      <For each={editor.paintIds()}>{id => <option value={id} selected={editor.selectedPaint() === id}>{editor.paintById().get(id)?.label} · {id}</option>}</For>
    </select></label>
    <div id="presets" class="presets" role="group" aria-label="Material recipes"><For each={PRESETS}>{id => {
      const preset = SURFACE_PRESETS[id];
      const palette = Object.fromEntries(PALETTE_KEYS.map(role => [role, displayHex(createFieldSampler(preset.recipe.palette[role])({position: [0, 0, 0]}).value)]));
      return <button class="preset" classList={{active: paint().preset === id}} aria-pressed={paint().preset === id}
        onClick={() => editor.applyPreset(id)}>
        <span class="preset-swatch" style={{background: `linear-gradient(135deg, ${palette.light}, ${palette.base} 45%, ${palette.shadow})`}}/>
        <span>{preset.label}</span>
      </button>;
    }}</For></div>
    <section class="control-section" aria-labelledby="pigment-title">
      <div class="section-heading"><h3 id="pigment-title">Pigment</h3><span>THE COLOUR OF MATTER</span></div>
      <div class="palette-controls"><For each={COLORS}>{color => <label>
        <Show when={editor.index().byId.get(paint().palette[color.key])?.kind === 'color'}
          fallback={<span class="palette-field-mark" title={paint().palette[color.key]}>ƒ</span>}>
          <ColorChip editor={editor} id={paint().palette[color.key]} label={color.accessible}/>
        </Show>
        <span>{color.label}</span>
      </label>}</For></div>
      <details class="palette-connections">
        <summary>Color field connections</summary>
        <p class="section-copy">Each pigment is a color field. Shared fields update every connected pigment.</p>
        <For each={COLORS}>{color => <div class="palette-connection">
          <label class="select-control"><span>{color.label}</span><select aria-label={`${color.accessible} source`}
            onChange={event => editor.setPaintPalette(color.key, event.currentTarget.value)}>
            <For each={sources()}>{source => <option value={source.id} selected={paint().palette[color.key] === source.id}>{source.id}</option>}</For>
          </select></label>
          <Show when={editor.index().byId.get(paint().palette[color.key])?.kind === 'color'} fallback={
            <p class="section-copy">A color expression. Sampling at the rest origin creates an independent constant color.</p>
          }>
            <details class="stop-linear-values">
              <summary>{color.label} · linear RGB values</summary>
              <LinearColorValues editor={editor} id={paint().palette[color.key]} label={`${paint().id} ${color.accessible}`}/>
            </details>
          </Show>
          <button class="wide-button" onClick={() => editor.separatePaintColor(color.key)}>
            {editor.index().byId.get(paint().palette[color.key])?.kind === 'color'
              ? `Make ${color.label.toLowerCase()} independent` : `Sample ${color.label.toLowerCase()} at rest origin`}
          </button>
        </div>}</For>
        <button class="wide-button" onClick={() => editor.showTab('compose')}>Edit field expressions in Compose →</button>
      </details>
      <div id="pigment-controls"><PaintControls editor={editor} paint={paint()} group="pigment"/></div>
    </section>
    <section class="control-section" aria-labelledby="surface-title">
      <div class="section-heading"><h3 id="surface-title">Surface</h3><span>FOLLOW THE FORM</span></div>
      <label class="select-control" for="field-target"><span>Painted field</span><select id="field-target"
        onChange={event => editor.setField(event.currentTarget.value)}>
        <For each={editor.fieldIds()}>{id => <option value={id} selected={paint().mapping.id === id}>{id} · {editor.index().fieldUsers.get(id)?.length ?? 0} paint(s)</option>}</For>
      </select></label>
      <p id="field-sharing" class="section-copy">{fieldUsers() > 1
        ? `This mapping is shared by ${fieldUsers()} paints. Scale and direction edits affect them together.` : 'This paint has its own mapping.'}</p>
      <button id="separate-field" class="wide-button" disabled={fieldUsers() < 2} onClick={editor.separateField}>Make this mapping independent</button>
      <div id="surface-controls"><PaintControls editor={editor} paint={paint()} group="surface"/></div>
    </section>
    <div class="seed-row"><label for="seed">Variation</label>
      <NumberInput id="seed" label="Variation" value={paint().mapping.seed} min={0} max={4294967295} step={1}
        onInput={seed => editor.queueMapping({seed})} onCommit={seed => { editor.queueMapping({seed}); return editor.gestureEnd(); }}/>
      <button id="reseed" class="icon-button" aria-label="Choose a new variation" title="Choose a new variation"
        onClick={() => editor.reseed(crypto.getRandomValues(new Uint32Array(1))[0])}>⤨</button>
    </div>
    </>;
    }}</Show>
  </section>;
}
