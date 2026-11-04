import {createMemo, For, Show} from 'solid-js';
import type {Editor} from '../editor';
import {COLOR_ADJUSTMENTS, colorSources} from '../color-authoring.mts';
import {sourcesFor} from '../composition.mts';
import {ColorChip} from './ColorControls';
import {NumberInput, RangeControl} from './Controls';

/** Ports retain ordinary graph identities; numeric gestures patch their parameters. */
export function ColorAdjustmentControl(props: {editor: Editor; id: string}) {
  const editor = props.editor;
  const adjustment = createMemo(() => {
    const node = editor.index().byId.get(props.id);
    return node?.kind === 'colorAdjust' ? node : undefined;
  });
  const colors = createMemo(() => colorSources(editor.graph(), props.id));
  const fields = createMemo(() => sourcesFor(editor.graph(), props.id, 'scalar'));
  return <Show when={adjustment()}>{node => <div class="color-adjustment">
    <label class="select-control adjustment-source"><span>Source color</span>
      <div class="color-stop-source">
        <ColorChip editor={editor} id={node().input} label={`${props.id} source color`}/>
        <select aria-label={`${props.id} source color field`} onChange={event => editor.setColorAdjustmentSource(props.id, 'input', event.currentTarget.value)}>
          <For each={colors()}>{source => <option value={source.id} selected={source.id === node().input}>{source.id}</option>}</For>
        </select>
      </div>
    </label>
    <p class="section-copy">Shape this color in Oklab. Zero lightness and hue with a chroma scale of one preserve the source.</p>
    <For each={COLOR_ADJUSTMENTS}>{control => {
      const source = () => node()[control.key];
      const uniform = createMemo(() => {
        const field = editor.index().byId.get(source());
        return field?.kind === 'parameter' || field?.kind === 'constant' ? field : undefined;
      });
      const uses = () => editor.index().users.get(source())?.length ?? 0;
      return <div class="adjustment-value">
        <Show when={uniform()} fallback={<p class="adjustment-driven"><span>{control.label}</span><span>Field · {source()}</span></p>}>{field =>
          <Show when={field().kind === 'parameter'} fallback={
            <label class="select-control"><span>{control.label}</span><NumberInput label={`${props.id}: ${control.label} value`}
              value={field().value} step={control.step} onCommit={value => editor.exposeColorAdjustmentValue(props.id, control.key, value)}/></label>
          }>
            <RangeControl id={`adjust-${props.id}-${control.key}`} context={props.id} label={control.label}
              value={field().value} min={control.min} max={control.max} step={control.step} editable
              onInput={value => editor.queue({[source()]: {value}})} onCommit={editor.gestureEnd}/>
          </Show>
        }</Show>
        <p class="adjustment-binding">{source()}{uses() > 1 ? ` · shared by ${uses()} expressions` : ''}</p>
      </div>;
    }}</For>
    <details class="adjustment-connections">
      <summary>Connect adjustment fields</summary>
      <p class="section-copy">Use any scalar field. Shared values change all uses; a new value is independent.</p>
      <For each={COLOR_ADJUSTMENTS}>{control => <label class="select-control"><span>{control.label}</span>
        <select aria-label={`${props.id} ${control.key} field`} onChange={event => {
          const source = event.currentTarget.value;
          if (source === 'new:value') editor.exposeColorAdjustmentValue(props.id, control.key);
          else editor.setColorAdjustmentSource(props.id, control.key, source);
        }}>
          <option value="new:value">New adjustable value</option>
          <For each={fields()}>{source => <option value={source.id} selected={node()[control.key] === source.id}>
            {source.id}{source.kind === 'constant' || source.kind === 'parameter' ? ` · ${Number(source.value.toPrecision(4))}` : ` · ${source.kind}`}
          </option>}</For>
        </select>
      </label>}</For>
    </details>
    <button class="wide-button remove-adjustment" onClick={() => editor.removeColorAdjustment(props.id)}>Remove adjustment · keep source</button>
  </div>}</Show>;
}
