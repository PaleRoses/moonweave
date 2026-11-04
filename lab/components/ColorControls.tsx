import {createMemo, For, Show} from 'solid-js';
import {createFieldSampler, displayColor} from '@moonweave/surfaces/core';
import type {ColorInterpolation, ColorSpace, MaterialGraph, Vec3} from '@moonweave/surfaces/core';
import type {Editor} from '../editor';
import {canAddRampStop, colorSources} from '../color-authoring.mts';
import {mixColorSamples} from '../../src/core/color-sample.mts';
import {NumberInput} from './Controls';

export const displayHex = (rgb: Vec3) => `#${displayColor({space: 'linear-rec709', coords: rgb}, 'srgb').coords
  .map(value => Math.round(255 * value).toString(16).padStart(2, '0')).join('')}`;
const RGB = [{label: 'R', index: 0}, {label: 'G', index: 1}, {label: 'B', index: 2}] as const;

/** Preview the transfer function with its color inputs sampled at the rest origin. */
function previewRamp(graph: MaterialGraph, id: string): {background: string; error?: string} {
  const node = graph.nodes.find(node => node.id === id);
  if (node?.kind !== 'colorRamp') return {background: 'none'};
  try {
    const samples = createFieldSampler(graph, Object.fromEntries(node.colors.map(id => [id, {id, sort: 'color' as const}])))(
      {position: [0, 0, 0]});
    const colors = node.colors.map(id => samples[id]);
    const low = node.positions[0], span = node.positions.at(-1)! - low;
    const stop = (rgb: Vec3, position: number) => `${displayHex(rgb)} ${100 * (position - low) / span}%`;
    const stops = [stop(colors[0].value, low)];
    for (let i = 1; i < colors.length; i++) {
      if (node.interpolation === 'constant') {
        stops.push(stop(colors[i - 1].value, node.positions[i]), stop(colors[i].value, node.positions[i]));
        continue;
      }
      for (let sample = 1; sample <= 8; sample++) {
        const t = sample / 8, weight = node.interpolation === 'smoothstep' ? t * t * (3 - 2 * t) : t;
        const mixed = mixColorSamples(colors[i - 1], colors[i], {value: weight, dx: 0, dy: 0}, node.space);
        stops.push(stop(mixed.value, node.positions[i - 1] + t * (node.positions[i] - node.positions[i - 1])));
      }
    }
    return {background: `linear-gradient(90deg, ${stops.join(',')})`};
  } catch (error) {
    return {background: 'none', error: error instanceof Error ? error.message : String(error)};
  }
}

export function LinearColorValues(props: {editor: Editor; id: string; label?: string}) {
  const color = createMemo(() => { const node = props.editor.index().byId.get(props.id); return node?.kind === 'color' ? node : undefined; });
  return <Show when={color()}>{node => <>
    <div class="direction-controls"><For each={RGB}>{channel => <label>{channel.label}
      <NumberInput label={`${props.label ?? props.id} linear ${channel.label}`} step={.001} value={node().value[channel.index]}
        onInput={value => props.editor.setColorChannel(props.id, channel.index, value)}
        onCommit={value => { props.editor.setColorChannel(props.id, channel.index, value); return props.editor.gestureEnd(); }}/>
    </label>}</For></div>
    <p class="section-copy" hidden={!node().value.some(value => value < 0 || value > 1)}>This field extends beyond display RGB. The swatch uses perceptual gamut mapping; stored values are preserved.</p>
  </>}</Show>;
}

export function ColorSpaceControl(props: {editor: Editor; id: string; space: ColorSpace}) {
  return <label class="select-control"><span>Color space</span><select aria-label={`${props.id} interpolation space`}
    onChange={event => props.editor.setColorProgram(props.id, {space: event.currentTarget.value as ColorSpace})}>
    <option value="linear-rgb" selected={props.space === 'linear-rgb'}>Linear RGB</option>
    <option value="oklab" selected={props.space === 'oklab'}>Oklab</option>
  </select></label>;
}

/** Compact edits use the same named color node as the full linear-value control. */
export function ColorChip(props: {editor: Editor; id: string; label: string}) {
  const color = createMemo(() => { const node = props.editor.index().byId.get(props.id); return node?.kind === 'color' ? node : undefined; });
  return <Show when={color()}>{node => <input class="color-chip" type="color" aria-label={props.label} value={displayHex(node().value)}
    onInput={event => props.editor.setColorHex(props.id, event.currentTarget.value)}
    onChange={props.editor.gestureEnd} onBlur={props.editor.gestureEnd}/>}</Show>;
}

export function ColorRampControl(props: {editor: Editor; id: string}) {
  const editor = props.editor;
  const ramp = createMemo(() => { const node = editor.index().byId.get(props.id); return node?.kind === 'colorRamp' ? node : undefined; });
  const sources = createMemo(() => colorSources(editor.graph(), props.id));
  const preview = createMemo(() => previewRamp(editor.graph(), props.id));
  return <Show when={ramp()}>{node => <>
    <div class="ramp-preview" role="img" aria-label={`${props.id} color ramp at the rest origin`} style={{background: preview().background}}/>
    <p class="ramp-preview-caption">{preview().error ?? 'Color inputs at the rest origin · display preview'}</p>
    <ColorSpaceControl editor={editor} id={props.id} space={node().space}/>
    <label class="select-control"><span>Transition</span><select aria-label={`${props.id} interpolation curve`}
      onChange={event => editor.setColorProgram(props.id, {interpolation: event.currentTarget.value as ColorInterpolation})}>
      <option value="linear" selected={node().interpolation === 'linear'}>Linear</option>
      <option value="smoothstep" selected={node().interpolation === 'smoothstep'}>Smooth</option>
      <option value="constant" selected={node().interpolation === 'constant'}>Steps</option>
    </select></label>
    <div class="color-stops"><For each={node().colors}>{(source, stop) => <div class="color-stop">
      <div class="color-stop-position"><span>Stop {stop() + 1}</span>
        <NumberInput label={`${props.id} stop ${stop() + 1} position`} step={.01} value={node().positions[stop()]}
          onInput={value => editor.setRampPosition(props.id, stop(), value)}
          onCommit={value => { editor.setRampPosition(props.id, stop(), value); return editor.gestureEnd(); }}/>
        <button class="remove-stop" aria-label={`${props.id}: remove stop ${stop() + 1}`} disabled={node().colors.length <= 2}
          onClick={() => editor.removeRampStop(props.id, stop())}>×</button>
      </div>
      <div class="color-stop-source"><ColorChip editor={editor} id={source} label={`${props.id} stop ${stop() + 1} color`}/>
        <select aria-label={`${props.id} stop ${stop() + 1} color source`} onChange={event => editor.setRampColor(props.id, stop(), event.currentTarget.value)}>
          <For each={sources()}>{color => <option value={color.id} selected={source === color.id}>{color.id}</option>}</For>
        </select>
      </div>
      <Show when={editor.index().byId.get(source)?.kind === 'color'}><details class="stop-linear-values">
        <summary>Linear RGB values</summary><LinearColorValues editor={editor} id={source}/>
      </details></Show>
    </div>}</For></div>
    <button class="wide-button" disabled={!canAddRampStop(editor.graph(), props.id)} onClick={() => editor.addRampStop(props.id)}>+ Add color stop</button>
    <p class="section-copy">Stops can share colors or use varying color fields. Their positions follow the input field.</p>
  </>}</Show>;
}
