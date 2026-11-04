import {batch, createMemo, createSignal} from 'solid-js';
import {color, compileGraph, patchGraph, serializeGraph, splitRecipe, SURFACE_PRESETS} from '@moonweave/surfaces/core';
import type {Channel, ColorInterpolation, ColorSpace, FacetMapping, GraphNode, GraphPatch, GraphPlan, MaterialGraph, PaletteRole, StylePatch, SurfacePreset, Vec3} from '@moonweave/surfaces/core';
import {addColorAdjustment, addRampStop, changeColorProgram, changePaintPalette, changeRampColor, connectColorAdjustment, exposeColorAdjustmentValue, separatePaintColor, isInlineColorValue, removeColorAdjustment, removeRampStop, resetPaintPalette} from './color-authoring.mts';
import type {ColorAdjustmentPort} from './color-authoring.mts';
import {addSurfaceDetail, connectDetailHeight, connectSurfaceFinish, exposeFinishValue, removeSurfaceDetail} from './surface-authoring.mts';
import {
  appendPaint, changePaintField, composeSurface, editLiteral,
  graphIndex, maskInfo, paintsIn, parseSurface, removeBlend,
  replaceBlendMask, reverseBlendMask, separatePaintField,
} from './composition.mts';
import {COMPOSITION_EXAMPLES} from './examples.mts';
import {createFrameBatch, mergeGraphChanges, readValueChanges} from './frame-batch.mts';
import type {FrameBatchOptions} from './frame-batch.mts';
import {EMPTY_HISTORY, recordHistory, stepHistory} from './history.mts';
import type {DocumentHistory, DocumentSnapshot} from './history.mts';

export type EditorTab = 'compose' | 'paint';
export type RegionMode = 'height' | 'facing' | 'uniform';
export type ExampleName = keyof typeof COMPOSITION_EXAMPLES;
export interface Notice {readonly message: string; readonly error: boolean}
export interface EditorSession extends DocumentSnapshot {
  readonly tab: EditorTab;
  readonly sourceDraft: string | null;
  readonly sourceOpen: boolean;
}
interface Gesture {
  readonly before: DocumentSnapshot;
  readonly changes: GraphPatch;
}
interface CommitOptions {
  original?: boolean;
  baseline?: MaterialGraph;
  paint?: string | null;
  blend?: string | null;
  forceSource?: boolean;
  history?: 'gesture' | 'skip';
  label?: string;
}
export interface EditorOptions {
  commit(graph: MaterialGraph, plan: GraphPlan): void;
  invalidate(): void;
  frames?: Pick<FrameBatchOptions, 'request' | 'cancel'>;
  initial?: EditorSession;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Graph values are authoritative. Selection and an unapplied source draft stay separate. */
export function createEditor(options: EditorOptions) {
  const initial = options.initial?.graph ?? composeSurface();
  const initialSelection = selectionFor(initial, options.initial?.selectedPaint ?? initial.output, options.initial?.selectedBlend ?? null);
  const [graph, setGraph] = createSignal<MaterialGraph>(initial);
  const [baseline, setBaseline] = createSignal<MaterialGraph>(options.initial?.baseline ?? initial);
  const plan = createMemo<GraphPlan>(() => compileGraph(graph()));
  const filteredImages = createMemo(() => plan().nodes.some(node =>
    (node.kind === 'imageScalar' || node.kind === 'imageColor') && (node.filter ?? 'linear') !== 'linear'));
  const [selectedPaint, setSelectedPaint] = createSignal(initialSelection.paint);
  const [selectedBlend, setSelectedBlend] = createSignal<string | null>(initialSelection.blend);
  const [tab, setTab] = createSignal<EditorTab>(options.initial?.tab ?? 'compose');
  const [notice, setNotice] = createSignal<Notice>({message: '', error: false});
  const [sourceOpen, setSourceOpen] = createSignal(options.initial?.sourceOpen ?? false);
  const [sourceDraft, setSourceDraft] = createSignal<string | null>(options.initial?.sourceDraft ?? null);
  const [shownSource, setShownSource] = createSignal<{graph: MaterialGraph; text: string} | null>(null);
  const [sourceNotice, setSourceNotice] = createSignal<Notice | null>(null);
  const sourceText = createMemo(() => sourceDraft() ?? shownSource()?.text ?? '');
  const sourceDirty = () => sourceDraft() !== null;
  const sourceError = () => sourceNotice()?.error ? sourceNotice()!.message : '';
  const [history, setHistory] = createSignal<DocumentHistory>(EMPTY_HISTORY);
  const [gesture, setGesture] = createSignal<Gesture | null>(null);
  let cachedSource: {graph: MaterialGraph; text: string} | null = null;
  let sourceWrites = 0, valueCommits = 0;

  const index = createMemo(() => graphIndex(graph()));
  const paints = createMemo(() => paintsIn(graph()));
  const paintById = createMemo(() => new Map(paints().map(paint => [paint.id, paint])));
  const paintIds = createMemo(() => paints().map(paint => paint.id));
  const fieldIds = createMemo(() => index().fields.map(field => field.id));
  const blendIds = createMemo(() => index().blends.map(blend => blend.id));
  const chosenPaint = createMemo(() => { const id = selectedPaint(); return id === null ? null : paintById().get(id) ?? null; });
  const livePaints = createMemo(() => paints().filter(paint => index().live.has(paint.id)));
  const liveSources = createMemo(() => index().sources.filter(source => index().live.has(source.id)));
  const mask = createMemo(() => selectedBlend() ? maskInfo(graph(), selectedBlend()!) : null);
  const maskControlIds = createMemo(() => mask()?.controls.map(node => node.id) ?? []);
  const surfaceControlIds = createMemo(() => index().surfaceControls.filter(node => !isInlineColorValue(graph(), node.id)).map(node => node.id));
  const edited = createMemo(() => graph() !== baseline());
  const title = createMemo(() => liveSources().length === 1 ? surfaceLabel(liveSources()[0]!.id)
    : liveSources().length === 2 ? liveSources().map(source => surfaceLabel(source.id)).join(' + ') : 'Composed surface');
  const description = createMemo(() => {
    const live = livePaints(), first = live[0];
    if (liveSources().length === 1 && first?.preset) return SURFACE_PRESETS[first.preset].description;
    const blends = index().blends.filter(blend => index().live.has(blend.id)).length;
    const materials = liveSources().length - live.length;
    if (materials) return `${materials} color material${materials === 1 ? '' : 's'}${live.length ? ` and ${live.length} paint${live.length === 1 ? '' : 's'}` : ''}, with shared fields for color and finish.`;
    return `${live.length} paint${live.length === 1 ? '' : 's'}, joined through ${blends} blend${blends === 1 ? '' : 's'}.`;
  });
  const expression = createMemo(() => {
    function visit(id: string, depth = 0): string {
      if (depth > 3) return id;
      const node = index().byId.get(id)!;
      const child = (ref: string) => visit(ref, depth + 1);
      switch (node.kind) {
        case 'paint': return surfaceLabel(id);
        case 'material': return `material(${child(node.color)})`;
        case 'color': return `linear(${node.value.map(value => Number(value.toPrecision(3))).join(', ')})`;
        case 'colorMix': return `color.mix(${child(node.a)}, ${child(node.b)}, ${child(node.mask)}${node.space === 'oklab' ? ', oklab' : ''})`;
        case 'colorRamp': return `color.ramp(${child(node.input)}, ${node.colors.length} stops, ${node.space})`;
        case 'imageColor': return `color.image(${node.image}, ${node.filter ?? 'linear'}, ${node.address})`;
        case 'imageScalar': return `scalar.image(${node.image}, ${node.channel}, ${node.filter ?? 'linear'}, ${node.address})`;
        case 'coat': return `coat(${child(node.input)}, ${child(node.color)}, ${node.mask})`;
        case 'noise': return `noise(${node.id})`;
        case 'parameter': case 'constant': return Number(node.value.toPrecision(3)).toString();
        case 'axis': return node.axis;
        case 'facing': return `facing(${node.id})`;
        case 'ramp': return `ramp(${child(node.input)})`;
        case 'complement': return `(1 − ${child(node.input)})`;
        case 'multiply': case 'add': return `(${child(node.a)} ${node.kind === 'multiply' ? '×' : '+'} ${child(node.b)})`;
        case 'mix': return `mix(${child(node.a)}, ${child(node.b)}, ${child(node.mask)})`;
        case 'bump': return `bump(${child(node.input)}, ${child(node.height)})`;
        case 'channels': case 'relief': return `${node.kind}(${child(node.input)})`;
        default: return id;
      }
    }
    const text = visit(graph().output);
    return text.length > 220 ? `${text.slice(0, 217)}…` : text;
  });
  const sourceStatus = createMemo(() => sourceNotice()?.message || (sourceDirty()
    ? 'Unapplied draft. Preview edits will not overwrite it.'
    : shownSource()?.graph === graph() ? 'This source is the surface currently shown.'
      : 'Surface updated. Use current graph to refresh this view.'));
  const gestureChanged = () => gesture() !== null && gesture()!.before.graph !== graph();
  const canUndo = () => gestureChanged() || history().past.length > 0;
  const canRedo = () => !gestureChanged() && history().future.length > 0;
  const session = createMemo<EditorSession>(() => ({graph: graph(), baseline: baseline(), selectedPaint: selectedPaint(), selectedBlend: selectedBlend(), tab: tab(), sourceDraft: sourceDraft(), sourceOpen: sourceOpen()}));

  function selectionFor(next: MaterialGraph, paint: string | null, blend: string | null) {
    const current = graphIndex(next);
    return {
      paint: paint !== null && current.byId.get(paint)?.kind === 'paint' ? paint : current.paints[0]?.id ?? null,
      blend: blend && current.byId.get(blend)?.kind === 'mix' ? blend
        : current.byId.get(next.output)?.kind === 'mix' ? next.output
          : current.blends.filter(item => current.live.has(item.id)).at(-1)?.id ?? current.blends[0]?.id ?? null,
    };
  }
  function snapshot(): DocumentSnapshot {
    return {graph: graph(), baseline: baseline(), selectedPaint: selectedPaint(), selectedBlend: selectedBlend()};
  }

  function tell(message: string, error = false) { setNotice({message, error}); }
  function surfaceLabel(id: string) {
    const nodes = index().byId;
    let node = nodes.get(id);
    while (node?.kind === 'channels' || node?.kind === 'relief') node = nodes.get(node.input);
    if (!node) return id;
    return paintById().get(node.id)?.label ?? (node.kind === 'material' ? `Color material · ${node.id}` : node.kind === 'mix' ? `Blend ${node.id}` : node.id);
  }
  function acceptedSource() {
    if (cachedSource?.graph !== graph()) {
      cachedSource = {graph: graph(), text: serializeGraph(graph())}; sourceWrites++;
    }
    return cachedSource.text;
  }
  function refreshSource(force = false) {
    if (sourceDirty() && !force) return;
    batch(() => {
      acceptedSource(); setShownSource(cachedSource); setSourceDraft(null); setSourceNotice(null);
    });
  }
  function commitGraph(next: MaterialGraph, settings: CommitOptions = {}) {
    const before = snapshot(), nextPlan = compileGraph(next);
    const paint = settings.paint === undefined ? selectedPaint() : settings.paint, blend = settings.blend === undefined ? selectedBlend() : settings.blend;
    const selection = selectionFor(next, paint, blend), nextBaseline = settings.baseline ?? (settings.original ? next : baseline());
    const changed = next !== graph();
    if (changed) options.commit(next, nextPlan);
    batch(() => {
      setGraph(next); setBaseline(nextBaseline); setSelectedPaint(selection.paint); setSelectedBlend(selection.blend);
      if (settings.forceSource) setSourceDraft(null);
      setSourceNotice(null); tell('');
      if (!settings.history) setHistory(current => recordHistory(current, before, {
        graph: next, baseline: nextBaseline, selectedPaint: selection.paint, selectedBlend: selection.blend,
      }, settings.label ?? 'Edit surface'));
    });
    if (settings.history !== 'gesture' && sourceOpen()) refreshSource();
    if (changed) options.invalidate();
  }
  const edits = createFrameBatch(changes => {
    try {
      const current = gesture(), before = current?.before ?? snapshot();
      const accumulated = mergeGraphChanges(current?.changes ?? {}, changes);
      if (current && accumulated === current.changes) { tell(''); return true; }
      const next = patchGraph(before.graph, accumulated);
      const valuesIn = (document: MaterialGraph): GraphPatch => {
        const nodes = graphIndex(document).byId;
        return Object.fromEntries(Object.entries(changes).map(([id, patch]) => [id, readValueChanges(patch, nodes.get(id)!)]));
      };
      const previousValues = valuesIn(graph()), nextValues = valuesIn(next);
      if (mergeGraphChanges(previousValues, nextValues) === previousValues) { tell(''); return true; }
      const accepted = mergeGraphChanges(current?.changes ?? {}, nextValues);
      batch(() => {
        commitGraph(next, {history: 'gesture'});
        setGesture({before, changes: accepted}); valueCommits++;
      });
      tell(''); return true;
    } catch (error) { tell(errorMessage(error), true); return false; }
  }, {...options.frames, scheduled: options.invalidate});
  function flush() {
    const accepted = edits.flush() !== false, completed = gesture();
    if (completed) batch(() => {
      setHistory(current => recordHistory(current, completed.before, snapshot(), 'Adjust values')); setGesture(null);
    });
    if (accepted && sourceOpen()) refreshSource();
    return accepted;
  }
  const gestureEnd = flush;
  function action(run: () => void) {
    if (!flush()) return false;
    try { run(); return true; }
    catch (error) { tell(errorMessage(error), true); return false; }
  }
  function queue(changes: GraphPatch) { edits.queue(changes); }
  function queueStyle(style: StylePatch) { const paint = chosenPaint(); if (paint) queue({[paint.id]: {style}}); }
  function queueMapping(mapping: Partial<FacetMapping>) { const paint = chosenPaint(); if (paint) queue({[paint.mapping.id]: mapping}); }
  function currentNode(id: string): GraphNode {
    return edits.value(id, index().byId.get(id)!);
  }
  function setBoundary(id: string, dimension: 'center' | 'width', value: number) {
    const node = currentNode(id);
    if (node.kind !== 'ramp') return;
    const center = dimension === 'center' ? value : (node.low + node.high) / 2;
    const half = dimension === 'width' ? value / 2 : (node.high - node.low) / 2;
    queue({[id]: {low: center - half, high: center + half}});
  }
  function setDirection(id: string, axis: 0 | 1 | 2, value: number) {
    const node = currentNode(id);
    if (node.kind !== 'facing') return;
    const direction: [number, number, number] = [...node.direction]; direction[axis] = value;
    queue({[id]: {direction}});
  }
  function setColorChannel(id: string, channel: 0 | 1 | 2, value: number) {
    const node = currentNode(id);
    if (node.kind !== 'color') return;
    const rgb: [number, number, number] = [...node.value]; rgb[channel] = value;
    queue({[id]: {value: rgb}});
  }
  function setColorHex(id: string, value: string) { queue({[id]: {value: color.srgb(value).value}}); }
  function setRampPosition(id: string, stop: number, value: number) {
    const node = currentNode(id);
    if (node.kind !== 'colorRamp') return;
    const positions = [...node.positions]; positions[stop] = value;
    queue({[id]: {positions}});
  }
  function setMatrixCell(id: string, column: number, row: number, value: number) {
    const node = currentNode(id);
    if (node.kind !== 'transform') return;
    const matrix = [...node.matrix]; matrix[column * 4 + row] = value;
    queue({[id]: {matrix}});
  }
  function importSource(text: string) {
    return action(() => {
      commitGraph(parseSurface(text), {original: true, forceSource: true, label: 'Import surface'}); tell('Surface restored.');
    });
  }
  function applySource() {
    if (!flush() || !sourceDirty()) return false;
    try {
      commitGraph(parseSurface(sourceText()), {original: true, forceSource: true, label: 'Apply source'}); refreshSource(true); return true;
    } catch (error) { setSourceNotice({message: errorMessage(error), error: true}); return false; }
  }
  function moveHistory(direction: 'undo' | 'redo') {
    if (!flush()) return false;
    const step = stepHistory(history(), direction);
    if (!step) return false;
    try {
      batch(() => {
        const next = step.document;
        commitGraph(next.graph, {paint: next.selectedPaint, blend: next.selectedBlend, baseline: next.baseline, history: 'skip'});
        setHistory(step.history);
      });
      return true;
    } catch (error) { tell(errorMessage(error), true); return false; }
  }
  if (sourceOpen()) refreshSource();

  return {
    graph, plan, filteredImages, index, paints, paintById, paintIds, fieldIds, blendIds, selectedPaint, selectedBlend,
    chosenPaint, livePaints, liveSources, mask, maskControlIds, surfaceControlIds, edited, tab, title, description, expression, notice,
    sourceOpen, sourceText, sourceDirty, sourceError, sourceStatus,
    tell, queue, queueStyle, queueMapping, currentNode, setBoundary, setDirection, setColorChannel, setColorHex, setRampPosition, setMatrixCell, flush, gestureEnd,
    acceptedSource, surfaceLabel, importSource, applySource, session, canUndo, canRedo,
    undo: () => moveHistory('undo'), redo: () => moveHistory('redo'),
    undoLabel: () => gestureChanged() ? 'Adjust values' : history().past.at(-1)?.label ?? '',
    redoLabel: () => history().future.at(-1)?.label ?? '',
    selectPaint: (id: string) => action(() => { setSelectedPaint(id); }),
    selectBlend: (id: string) => action(() => { setSelectedBlend(id); }),
    showTab: (next: EditorTab) => action(() => { setTab(next); }),
    addPaint: () => action(() => {
      const added = appendPaint(graph(), {field: chosenPaint()?.mapping.id});
      commitGraph(added.graph, {paint: added.paintId, blend: added.blendId, label: 'Add paint'});
    }),
    setField: (id: string) => action(() => { const paint = chosenPaint(); if (paint) commitGraph(changePaintField(graph(), paint.id, id), {label: 'Change painted field'}); }),
    separateField: () => action(() => { const paint = chosenPaint(); if (paint) commitGraph(separatePaintField(graph(), paint.id), {label: 'Separate painted field'}); }),
    setRegion: (mode: RegionMode) => action(() => commitGraph(replaceBlendMask(graph(), selectedBlend()!, mode), {label: 'Change blend region'})),
    reverseMask: () => action(() => commitGraph(reverseBlendMask(graph(), selectedBlend()!), {label: 'Reverse blend mask'})),
    removeBlend: () => action(() => commitGraph(removeBlend(graph(), selectedBlend()!), {label: 'Remove blend'})),
    addDetail: (source?: string) => action(() => commitGraph(addSurfaceDetail(graph(), source), {label: 'Add height detail'})),
    setDetailHeight: (id: string, source: string) => action(() => commitGraph(connectDetailHeight(graph(), id, source), {label: 'Replace height expression'})),
    removeDetail: (id: string) => action(() => commitGraph(removeSurfaceDetail(graph(), id), {label: 'Remove height detail'})),
    setFinishField: (channel: Channel, source?: string) => action(() => commitGraph(connectSurfaceFinish(graph(), channel, source), {label: 'Connect finish field'})),
    exposeFinishValue: (channel: Channel) => action(() => commitGraph(exposeFinishValue(graph(), channel), {label: 'Expose finish value'})),
    setLiteral: (id: string, value: number) => action(() => commitGraph(editLiteral(graph(), id, value), {label: 'Change fixed value'})),
    setColorProgram: (id: string, settings: {space?: ColorSpace; interpolation?: ColorInterpolation}) => action(() => commitGraph(changeColorProgram(graph(), id, settings), {label: 'Change color interpolation'})),
    addColorAdjustment: (id: string) => action(() => commitGraph(addColorAdjustment(graph(), id), {label: 'Add color adjustment'})),
    setColorAdjustmentSource: (id: string, port: 'input' | ColorAdjustmentPort, source: string) => action(() => commitGraph(connectColorAdjustment(graph(), id, port, source), {label: 'Connect color adjustment'})),
    exposeColorAdjustmentValue: (id: string, port: ColorAdjustmentPort, value?: number) => action(() => commitGraph(exposeColorAdjustmentValue(graph(), id, port, value), {label: 'Make adjustment value independent'})),
    removeColorAdjustment: (id: string) => action(() => commitGraph(removeColorAdjustment(graph(), id), {label: 'Remove color adjustment'})),
    setRampColor: (id: string, stop: number, source: string) => action(() => commitGraph(changeRampColor(graph(), id, stop, source), {label: 'Connect ramp color'})),
    addRampStop: (id: string) => action(() => commitGraph(addRampStop(graph(), id), {label: 'Add color stop'})),
    removeRampStop: (id: string, stop: number) => action(() => commitGraph(removeRampStop(graph(), id, stop), {label: 'Remove color stop'})),
    setPaintPalette: (role: PaletteRole, source: string) => action(() => {
      const paint = chosenPaint(); if (paint) commitGraph(changePaintPalette(graph(), paint.id, role, source), {label: 'Connect paint pigment'});
    }),
    separatePaintColor: (role: PaletteRole) => action(() => {
      const paint = chosenPaint(); if (paint) commitGraph(separatePaintColor(graph(), paint.id, role), {label: 'Make paint color independent'});
    }),
    useDirection: (id: string, direction: Vec3) => action(() => commitGraph(patchGraph(graph(), {[id]: {direction}}), {label: 'Change surface direction'})),
    applyPreset: (preset: SurfacePreset) => action(() => {
      const paint = chosenPaint(); if (!paint) return;
      const {style, mapping} = splitRecipe(preset);
      const restored = resetPaintPalette(graph(), paint.id, preset);
      commitGraph(patchGraph(restored, {[paint.id]: {style}, [paint.mapping.id]: mapping}), {label: 'Apply paint preset'});
    }),
    reseed: (seed: number) => action(() => { const paint = chosenPaint(); if (paint) commitGraph(patchGraph(graph(), {[paint.mapping.id]: {seed}}), {label: 'Change variation'}); }),
    useExample: (name: ExampleName) => action(() => commitGraph(COMPOSITION_EXAMPLES[name].create(), {original: true, paint: 'basePaint', blend: 'surface', label: 'Use example'})),
    reset: () => action(() => commitGraph(baseline(), {label: 'Reset surface'})),
    openSource: () => action(() => { setSourceOpen(true); refreshSource(); }),
    closeSource: () => setSourceOpen(false),
    editSource: (text: string) => batch(() => { setSourceDraft(text); setSourceNotice(null); }),
    refreshSource: () => action(() => refreshSource(true)),
    sourceForCopy: () => {
      if (!flush()) return null;
      if (!sourceDirty()) refreshSource();
      return sourceText();
    },
    sourceFeedback: (message: string) => setSourceNotice({message, error: false}),
    metrics: () => ({sourceWrites, valueCommits}),
    dispose: () => edits.dispose(),
  };
}

export type Editor = ReturnType<typeof createEditor>;
