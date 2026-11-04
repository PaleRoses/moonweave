import test from 'node:test';
import assert from 'node:assert/strict';
import {composeSurface} from '../lab/composition.mts';
import {patchGraph} from '../src/core.mjs';
import {EMPTY_HISTORY, recordHistory, stepHistory} from '../lab/history.mts';

test('bounded history keeps the latest hundred immutable documents and redoes them in order', () => {
  const graph = composeSurface();
  let document = {graph, baseline: graph, selectedPaint: 'basePaint', selectedBlend: null};
  let history = EMPTY_HISTORY;
  const documents = [document];
  for (let i = 1; i <= 105; i++) {
    const next = {...document, graph: patchGraph(document.graph, {basePaint: {style: {roughness: i / 106}}})};
    history = recordHistory(history, document, next, 'Adjust values'); document = next; documents.push(next);
  }
  assert.equal(history.past.length, 100);
  for (let i = 104; i >= 5; i--) {
    const step = stepHistory(history, 'undo'); history = step.history;
    assert.equal(step.document, documents[i]);
  }
  assert.equal(stepHistory(history, 'undo'), null);
  for (let i = 6; i <= 105; i++) {
    const step = stepHistory(history, 'redo'); history = step.history;
    assert.equal(step.document, documents[i]);
  }
  assert.equal(stepHistory(history, 'redo'), null);
  assert.equal(recordHistory(history, document, {...document, selectedPaint: 'another'}, 'Select paint'), history);
});
