import {createMemo, createSignal, For, Show} from 'solid-js';
import type {GraphNode} from '@moonweave/surfaces/core';
import type {Editor} from '../editor';
import {sourcesFor} from '../composition.mts';
import {FINISH_FIELDS, surfaceFinish} from '../surface-authoring.mts';

function fieldLabel(node: GraphNode): string {
  if (node.kind === 'constant' || node.kind === 'parameter') return `${node.id} · ${Number(node.value.toPrecision(4))}`;
  if (node.kind === 'multiply' || node.kind === 'add') return `${node.id} · ${node.a} ${node.kind === 'multiply' ? '×' : '+'} ${node.b}`;
  return `${node.id} · ${node.kind === 'axis' ? node.axis : node.kind}`;
}

/** Connections edit ordinary graph ports; the editor owns commits and undo. */
export function FieldApplications(props: {editor: Editor}) {
  const editor = props.editor;
  const [newHeight, setNewHeight] = createSignal('');
  const newSource = () => editor.index().byId.has(newHeight()) ? newHeight() : '';
  const sourceChoices = createMemo(() => sourcesFor(editor.graph(), editor.graph().output, 'scalar'));
  const details = createMemo(() => editor.graph().nodes.filter(node => node.kind === 'bump' && editor.index().live.has(node.id)));
  const finish = createMemo(() => surfaceFinish(editor.graph()));
  return <section class="control-section field-applications" aria-labelledby="field-applications-title">
    <div class="section-heading"><h3 id="field-applications-title">Height detail</h3><span>{details().length} APPLICATION{details().length === 1 ? '' : 'S'}</span></div>
    <p class="section-copy">Signed height creates raised or engraved shading. Scale or mask a field before applying it.</p>
    <For each={details()}>{detail => <Show when={detail.kind === 'bump' ? detail : undefined}>{node =>
      <div class="height-detail">
        <div class="height-detail-heading"><strong>{node().id}</strong><button aria-label={`${node().id}: remove height detail`}
          onClick={() => editor.removeDetail(node().id)}>Remove</button></div>
        <label class="select-control"><span>Height expression</span><select aria-label={`${node().id} height expression`}
          onChange={event => editor.setDetailHeight(node().id, event.currentTarget.value)}>
          <For each={sourcesFor(editor.graph(), node().id, 'scalar')}>{source =>
            <option value={source.id} selected={source.id === node().height}>{fieldLabel(source)}</option>
          }</For>
        </select></label>
      </div>
    }</Show>}</For>
    <label class="select-control"><span>New detail field</span><select aria-label="New detail field" value={newSource()}
      onChange={event => setNewHeight(event.currentTarget.value)}>
      <option value="">New grain</option>
      <For each={sourceChoices()}>{source => <option value={source.id}>{fieldLabel(source)}</option>}</For>
    </select></label>
    <button class="wide-button" onClick={() => editor.addDetail(newSource() || undefined)}>+ Add height detail</button>
    <p class="section-copy">Each added detail contributes another height variation. Replacing a height expression changes only that application.</p>
    <details class="finish-connections">
      <summary>Connect finish fields</summary>
      <p class="section-copy">A field can drive pigment, height and finish together. An override takes precedence over the surface below it.</p>
      <For each={FINISH_FIELDS}>{channel => <label class="select-control"><span>{channel.label}</span>
        <select aria-label={`${channel.label} field`} onChange={event => {
          const source = event.currentTarget.value;
          if (source === 'new:value') editor.exposeFinishValue(channel.key);
          else editor.setFinishField(channel.key, source || undefined);
        }}>
          <option value="" selected={finish()?.values[channel.key] === undefined}>Inherit surface</option>
          <option value="new:value">New adjustable value</option>
          <For each={sourceChoices()}>{source => <option value={source.id}
            selected={finish()?.values[channel.key] === source.id}>{fieldLabel(source)}</option>}</For>
        </select>
      </label>}</For>
    </details>
  </section>;
}
