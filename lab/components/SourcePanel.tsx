import {For, Show, createMemo} from 'solid-js';
import type {GraphNode} from '@moonweave/surfaces/core';
import type {Editor} from '../editor';
import {ExecutionGraph} from './ExecutionGraph';

type ImageReader = Extract<GraphNode, {kind: 'imageScalar' | 'imageColor'}>;

const STATISTICS = [
  ['paintSamples', 'Sampled facet fields'], ['proceduralSamples', 'Procedural field evaluations'], ['textureReads', 'Texture reads / fragment'],
  ['uniformScalars', 'Numeric uniforms'], ['nodes', 'Compiled graph nodes'],
] as const;

interface SourcePanelProps {
  editor: Editor;
  register(element: HTMLDetailsElement): void;
  copy(source: string, onFailure: () => void): void;
}

export function SourcePanel(props: SourcePanelProps) {
  const editor = props.editor;
  const images = createMemo(() => editor.graph().nodes.filter(node => node.kind === 'image' && editor.index().live.has(node.id)));
  const readers = createMemo(() => editor.graph().nodes.filter((node): node is ImageReader =>
    (node.kind === 'imageScalar' || node.kind === 'imageColor') && editor.index().live.has(node.id)));
  const imageReaders = (id: string) => readers().filter(node => node.image === id);
  const channelLabel = (id: string, channels: number) => channels === 1 ? 'scalar'
    : imageReaders(id).some(node => node.kind === 'imageColor') ? 'linear RGB' : '3 scalar channels';
  let source!: HTMLTextAreaElement;
  return <details id="graph-panel" class="graph-panel" ref={props.register} open={editor.sourceOpen()}
    onToggle={event => {
      if (event.currentTarget.open && !editor.sourceOpen()) {
        if (!editor.openSource()) event.currentTarget.open = false;
      } else if (!event.currentTarget.open) editor.closeSource();
    }}>
    <summary><span><span class="eyebrow">THE SURFACE, EXPOSED</span><strong>A graph you can read, edit and reuse.</strong></span>
      <span id="graph-cost">{editor.plan().cost.paintSamples} facet · {editor.plan().cost.proceduralSamples} procedural · {editor.filteredImages() ? '≤ ' : ''}{editor.plan().cost.textureReads} reads</span>
    </summary>
    <div class="graph-body"><div class="graph-explanation">
      <h3>Every part has a place.</h3><p>Fields drive color, regions and finish. Color materials and paints compose into one surface. Take the same graph into your own scene.</p>
      <dl id="graph-statistics"><For each={STATISTICS}>{([key, label]) => <><dt>{key === 'textureReads' && editor.filteredImages() ? 'Texture-read ceiling / fragment' : label}</dt><dd>{key === 'nodes' ? editor.plan().nodes.length : editor.plan().cost[key]}</dd></>}</For></dl>
      <Show when={editor.filteredImages()}><p>Filtered readers choose their mip levels and tap counts from the pixel footprint. The read count is an upper bound.</p></Show>
      <Show when={images().length}><section class="image-resources" aria-label="Shared image resources">
        <h3>Shared image resources</h3>
        <For each={images()}>{node => <Show when={node.kind === 'image' ? node : undefined}>{image =>
          <div><p><code>{image().id}</code><br/>{image().resource.width} × {image().resource.height} · {channelLabel(image().id, image().resource.channels)} · embedded in this graph</p>
            <For each={imageReaders(image().id)}>{reader =>
              <p><code>{reader.id}</code> · {reader.kind === 'imageScalar' ? reader.channel : 'RGB'} · {reader.filter ?? 'linear'} · {reader.address} · <code>{reader.domain ?? 'rest coordinates'}</code></p>
            }</For>
          </div>
        }</Show>}</For>
      </section></Show>
      <p id="graph-edit-status" class="section-copy" classList={{'graph-edit-error': !!editor.sourceError()}} role="status">{editor.sourceStatus()}</p>
      <div class="graph-actions">
        <button id="apply-graph" class="primary" disabled={!editor.sourceDirty()} onClick={editor.applySource}>Apply graph</button>
        <button id="copy-graph" onClick={() => {
          const text = editor.sourceForCopy();
          if (text !== null) props.copy(text, () => {
            source.focus(); source.select();
            editor.sourceFeedback('The source is selected. Copy it with your browser’s copy command.');
          });
        }}>Copy JSON</button>
        <button id="restore-graph" onClick={editor.refreshSource}>Use current graph</button>
      </div>
    </div><div class="graph-source">
      <label for="graph-json">Surface graph · JSON</label>
      <textarea id="graph-json" ref={source} value={editor.sourceText()} spellcheck={false} autocomplete="off" aria-describedby="graph-source-help"
        onInput={event => editor.editSource(event.currentTarget.value)}/>
      <p id="graph-source-help">Edits are validated before they replace the current surface. Existing recipes and surface graphs can also be imported.</p>
    </div></div>
    <Show when={editor.sourceOpen()}><ExecutionGraph editor={editor}/></Show>
  </details>;
}
