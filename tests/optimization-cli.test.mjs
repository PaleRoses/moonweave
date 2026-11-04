import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('CLI artifact paths cannot overwrite either authored or optimized graph files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'moonweave-paths-'));
  try {
    for (const [inputName, outputName] of [['job.json', 'result.json'], ['source.json', 'candidate.json']]) {
      const input = join(directory, inputName), output = join(directory, outputName);
      writeFileSync(input, 'authored graph sentinel');
      writeFileSync(output, 'existing output sentinel');
      const result = spawnSync(process.execPath, ['tools/optimize-graph.mjs', input, output, '--artifacts', directory], {encoding: 'utf8'});
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Artifact paths must be distinct/);
      assert.equal(readFileSync(input, 'utf8'), 'authored graph sentinel');
      assert.equal(readFileSync(output, 'utf8'), 'existing output sentinel');
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
