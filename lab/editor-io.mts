import * as Effect from 'effect/Effect';
import {GRAPH_LIMITS} from '@moonweave/surfaces/core';

export class EditorIOError extends Error {
  readonly _tag = 'EditorIOError';
  readonly operation: 'read' | 'copy' | 'download';
  constructor(operation: EditorIOError['operation'], message: string, cause?: unknown) {
    super(message, {cause});
    this.name = 'EditorIOError';
    this.operation = operation;
  }
}

export function readSurfaceFile(file: File): Effect.Effect<string, EditorIOError> {
  if (file.size > GRAPH_LIMITS.jsonBytes) return Effect.fail(new EditorIOError('read', `Surface files must be ${GRAPH_LIMITS.jsonBytes / 1048576} MiB or smaller.`));
  return Effect.tryPromise({
    try: () => file.text(),
    catch: cause => new EditorIOError('read', `Could not read ${file.name}.`, cause),
  });
}

export function copyText(text: string): Effect.Effect<void, EditorIOError> {
  return Effect.tryPromise({
    try: () => navigator.clipboard.writeText(text),
    catch: cause => new EditorIOError('copy', 'Clipboard access was not available. Select the text to copy it manually.', cause),
  });
}

/** Each download retains its URL for the browser handoff window. */
export function downloadBlob(blob: Blob, filename: string): Effect.Effect<void, EditorIOError> {
  return Effect.scoped(Effect.gen(function* () {
    const url = yield* Effect.acquireRelease(
      Effect.try({try: () => URL.createObjectURL(blob), catch: cause => new EditorIOError('download', 'Could not prepare the download.', cause)}),
      url => Effect.sync(() => URL.revokeObjectURL(url)),
    );
    yield* Effect.try({
      try: () => {
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
      },
      catch: cause => new EditorIOError('download', 'Could not start the download.', cause),
    });
    yield* Effect.sleep('1 second');
  }));
}

export function downloadText(text: string, filename: string): Effect.Effect<void, EditorIOError> {
  return downloadBlob(new Blob([text], {type: 'application/json'}), filename);
}
