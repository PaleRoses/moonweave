import {createMemo, For, Show} from 'solid-js';
import type {Vec3} from '@moonweave/surfaces/core';
import type {Editor} from '../editor';
import {NumberInput, RangeControl} from './Controls';
import {ColorRampControl, ColorSpaceControl, displayHex, LinearColorValues} from './ColorControls';
import {ColorAdjustmentControl} from './ColorAdjustmentControl';
import {nodeType} from '../../src/core/graph.mts';
import {isHeightAmplitude} from '../surface-authoring.mts';

const DIRECTIONS: readonly {label: string; value: Vec3}[] = [
  {label: 'Across', value: [1, 0, 0]}, {label: 'Up', value: [0, 1, 0]},
  {label: 'Down', value: [0, -1, 0]}, {label: 'Depth', value: [0, 0, 1]},
];
const AXES = [{label: 'X', index: 0}, {label: 'Y', index: 1}, {label: 'Z', index: 2}] as const;
const COLUMNS = ['X', 'Y', 'Z', 'Offset'] as const;

/** One value editor serves surface inputs and scalar mask expressions. */
export function ExpressionControl(props: {editor: Editor; id: string}) {
  const editor = props.editor;
  const node = () => editor.index().byId.get(props.id);
  const parameter = createMemo(() => { const item = node(); return item?.kind === 'parameter' ? item : undefined; });
  const literal = createMemo(() => { const item = node(); return item?.kind === 'constant' ? item : undefined; });
  const ramp = createMemo(() => { const item = node(); return item?.kind === 'ramp' ? item : undefined; });
  const facing = createMemo(() => { const item = node(); return item?.kind === 'facing' ? item : undefined; });
  const noise = createMemo(() => { const item = node(); return item?.kind === 'noise' ? item : undefined; });
  const color = createMemo(() => { const item = node(); return item?.kind === 'color' ? item : undefined; });
  const colorMix = createMemo(() => { const item = node(); return item?.kind === 'colorMix' ? item : undefined; });
  const transform = createMemo(() => { const item = node(); return item?.kind === 'transform' ? item : undefined; });
  const isColor = () => { const item = node(); return item && nodeType(item) === 'color'; };
  const users = () => editor.index().users.get(props.id)?.length ?? 0;
  const heightAmplitude = createMemo(() => parameter() !== undefined && isHeightAmplitude(editor.graph(), props.id));
  return <section class="mask-node">
    <div class="mask-node-heading"><strong>{props.id}</strong><span>{node()?.kind === 'constant' ? 'FIXED VALUE' : node()?.kind === 'colorAdjust' ? 'COLOR ADJUSTMENT' : node()?.kind.toUpperCase()}</span></div>
    <p class="mask-sharing" hidden={users() < 2}>Used by {users()} expressions. Edits affect every use.</p>
    <Show when={parameter()}>{item => <RangeControl id={`mask-${props.id}`} context={props.id}
      label={heightAmplitude() ? 'Height amplitude' : editor.mask()?.strength?.id === props.id ? 'Mask strength' : 'Parameter'}
      value={item().value} min={heightAmplitude() ? -.15 : 0} max={heightAmplitude() ? .15 : 1} step={heightAmplitude() ? .001 : .01} editable
      onInput={value => editor.queue({[props.id]: {value}})} onCommit={editor.gestureEnd}/>}</Show>
    <Show when={literal()}>{item => <>
      <label class="select-control"><span>Literal</span><NumberInput label={`${props.id} literal value`}
        value={item().value} onCommit={value => editor.setLiteral(props.id, value)}/></label>
      <p class="section-copy">A fixed value. Changing it may select a different program.</p>
    </>}</Show>
    <Show when={ramp()}>{item => <>
      <RangeControl id={`mask-${props.id}-center`} context={props.id} label="Boundary position"
        value={(item().low + item().high) / 2} min={-2.5} max={2.5} step={.01} editable
        onInput={value => editor.setBoundary(props.id, 'center', value)} onCommit={editor.gestureEnd}/>
      <RangeControl id={`mask-${props.id}-width`} context={props.id} label="Transition width"
        value={item().high - item().low} min={.02} max={4} step={.01} editable
        onInput={value => editor.setBoundary(props.id, 'width', value)} onCommit={editor.gestureEnd}/>
    </>}</Show>
    <Show when={facing()}>{item => <>
      <div class="direction-controls"><For each={AXES}>{axis => <label>{axis.label}
        <NumberInput label={`${props.id} direction ${axis.label}`} step={.1} value={item().direction[axis.index]}
          onInput={value => editor.setDirection(props.id, axis.index, value)}
          onCommit={value => { editor.setDirection(props.id, axis.index, value); return editor.gestureEnd(); }}/>
      </label>}</For></div>
      <div class="axis-shortcuts"><For each={DIRECTIONS}>{direction => <button
        onClick={() => editor.useDirection(props.id, direction.value)}>{direction.label}</button>}</For></div>
    </>}</Show>
    <Show when={noise()}>{item => <div class="seed-row">
      <label for={`seed-${props.id}`}>Variation</label>
      <NumberInput id={`seed-${props.id}`} label={`${props.id} variation`} value={item().seed} min={0} max={4294967295} step={1}
        onInput={seed => editor.queue({[props.id]: {seed}})}
        onCommit={seed => { editor.queue({[props.id]: {seed}}); return editor.gestureEnd(); }}/>
      <button class="icon-button" aria-label={`${props.id}: choose a new variation`} onClick={() => {
        editor.queue({[props.id]: {seed: crypto.getRandomValues(new Uint32Array(1))[0]}}); editor.gestureEnd();
      }}>⤨</button>
    </div>}</Show>
    <Show when={color()}>{item => <>
      <label class="expression-color"><input type="color" aria-label={`${props.id} color`} value={displayHex(item().value)}
        onInput={event => editor.setColorHex(props.id, event.currentTarget.value)} onChange={editor.gestureEnd} onBlur={editor.gestureEnd}/>
        <span>Color <small>sRGB picker · linear RGB values below</small></span></label>
      <LinearColorValues editor={editor} id={props.id}/>
    </>}</Show>
    <Show when={colorMix()}>{item => <ColorSpaceControl editor={editor} id={props.id} space={item().space ?? 'linear-rgb'}/>}</Show>
    <Show when={node()?.kind === 'colorRamp'}><ColorRampControl editor={editor} id={props.id}/></Show>
    <Show when={node()?.kind === 'colorAdjust'}><ColorAdjustmentControl editor={editor} id={props.id}/></Show>
    <Show when={isColor() && users() > 0}>
      <button class="wide-button add-color-adjustment" aria-label={`${props.id}: add color adjustment`}
        onClick={() => editor.addColorAdjustment(props.id)}>+ {node()?.kind === 'colorAdjust' ? 'Add another adjustment' : 'Add color adjustment'}</button>
      <p class="adjustment-scope" hidden={users() < 2}>Applies to all {users()} connected uses of this color.</p>
    </Show>
    <Show when={transform()}>{item => <details class="expression-matrix">
      <summary>Coordinate scale, direction and offset</summary>
      <p class="section-copy">Rows map X, Y and Z. Diagonal values set scale; the last column offsets the field.</p>
      <div class="matrix-heading"><For each={COLUMNS}>{label => <span>{label}</span>}</For></div>
      <For each={AXES}>{row => <div class="direction-controls"><For each={COLUMNS}>{(label, column) =>
        <NumberInput label={`${props.id} ${row.label} from ${label}`} step={.1} value={item().matrix[column() * 4 + row.index]}
          onInput={value => editor.setMatrixCell(props.id, column(), row.index, value)}
          onCommit={value => { editor.setMatrixCell(props.id, column(), row.index, value); return editor.gestureEnd(); }}/>
      }</For></div>}</For>
    </details>}</Show>
  </section>;
}
