import {createEffect, createSignal, Show, untrack} from 'solid-js';

interface NumberInputProps {
  id?: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number | 'any';
  class?: string;
  onInput?: (value: number) => void;
  onCommit(value: number): boolean;
}

// Suppress arithmetic display noise without rounding the stored graph or a focused draft.
const displayNumber = (value: number) => String(Number(value.toPrecision(15)));

/** Keep incomplete typing local; the graph receives numbers and owns accepted values. */
export function NumberInput(props: NumberInputProps) {
  const [draft, setDraft] = createSignal(displayNumber(props.value));
  const [focused, setFocused] = createSignal(false);
  let dirty = false;
  function finish(input: HTMLInputElement) {
    if (dirty) {
      props.onCommit(input.valueAsNumber);
      dirty = false;
    }
    setDraft(displayNumber(props.value));
  }
  createEffect(() => {
    const value = props.value;
    if (!untrack(focused)) setDraft(displayNumber(value));
  });
  return <input id={props.id} class={props.class} type="number" aria-label={props.label}
    min={props.min} max={props.max} step={props.step ?? 'any'} value={draft()}
    onFocus={() => setFocused(true)}
    onInput={event => {
      dirty = true;
      setDraft(event.currentTarget.value);
      if (Number.isFinite(event.currentTarget.valueAsNumber)) props.onInput?.(event.currentTarget.valueAsNumber);
    }}
    onChange={event => finish(event.currentTarget)}
    onBlur={event => { setFocused(false); finish(event.currentTarget); }}/>
}

export interface RangeControlProps {
  id: string;
  label: string;
  context?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  editable?: boolean;
  format?: (value: number) => string;
  onInput(value: number): void;
  onCommit(): boolean;
}

export function RangeControl(props: RangeControlProps) {
  const [value, setValue] = createSignal(props.value);
  let rangeDirty = false;
  createEffect(() => setValue(props.value));
  const accessibleLabel = () => props.context ? `${props.context}: ${props.label}` : props.label;
  function input(next: number) {
    if (Number.isFinite(next)) setValue(next);
    props.onInput(next);
  }
  function commit() {
    const accepted = props.onCommit(); setValue(props.value); return accepted;
  }
  function finishRange() {
    if (rangeDirty) { rangeDirty = false; commit(); }
  }
  return <div class="control">
    <div class="control-line"><label for={props.id}>{props.label}</label>
      <Show when={props.editable} fallback={<output for={props.id}>{props.format?.(value()) ?? value().toFixed(2)}</output>}>
        <NumberInput class="range-number" label={`${accessibleLabel()} value`} value={value()}
          onInput={input} onCommit={next => { input(next); return commit(); }}/>
      </Show>
    </div>
    <input id={props.id} type="range" aria-label={accessibleLabel()} value={value()}
      min={Math.min(props.min, value())} max={Math.max(props.max, value())} step={props.step}
      onInput={event => { rangeDirty = true; input(event.currentTarget.valueAsNumber); }}
      onChange={finishRange} onBlur={finishRange} onPointerCancel={finishRange}/>
  </div>;
}
