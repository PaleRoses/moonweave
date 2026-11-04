import test from 'node:test';
import assert from 'node:assert/strict';
import * as Effect from 'effect/Effect';
import {readSurfaceFile, downloadBlob} from '../lab/editor-io.mts';
import {GRAPH_LIMITS} from '../src/core.mjs';

test('surface imports enforce the byte limit before reading and preserve read failures', async () => {
  let reads = 0;
  const large = {size: GRAPH_LIMITS.jsonBytes + 1, name: 'large.json', text() { reads++; return Promise.resolve('{}'); }};
  await assert.rejects(Effect.runPromise(readSurfaceFile(large)), /MiB/);
  assert.equal(reads, 0);
  const failure = {size: 10, name: 'broken.json', text: () => Promise.reject(new Error('disk failure'))};
  await assert.rejects(Effect.runPromise(readSurfaceFile(failure)), /Could not read broken.json/);
  assert.equal(await Effect.runPromise(readSurfaceFile(new File(['{}'], 'surface.json'))), '{}');
});

test('a cancelled download releases its URL exactly once', async () => {
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const events = [];
  URL.createObjectURL = () => { events.push('acquire'); return 'blob:test'; };
  URL.revokeObjectURL = value => events.push(`release:${value}`);
  globalThis.document = {createElement() { return {click() { events.push(`click:${this.download}`); }}; }};
  try {
    const controller = new AbortController();
    const running = Effect.runPromise(downloadBlob(new Blob(['test']), 'surface.json'), {signal: controller.signal});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(events, ['acquire', 'click:surface.json']);
    controller.abort();
    await assert.rejects(running);
    assert.deepEqual(events, ['acquire', 'click:surface.json', 'release:blob:test']);
  } finally {
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
});

test('a failed download click closes its scope', async () => {
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  let releases = 0;
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => { releases++; };
  globalThis.document = {createElement() { return {click() { throw new Error('download denied'); }}; }};
  try {
    await assert.rejects(Effect.runPromise(downloadBlob(new Blob(), 'surface.json')), /Could not start the download/);
    assert.equal(releases, 1);
  } finally {
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke;
  }
});
