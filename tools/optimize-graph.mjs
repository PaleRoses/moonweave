#!/usr/bin/env node
/** Optional offline optimizer. Python/egglog never enter the runtime package. */
import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {GRAPH_LIMITS, materialGraph, parseGraph, serializeGraph} from '../src/core.mjs';
import {createOptimizationJob, applyOptimization} from '../src/optimize.mjs';

const driver = fileURLToPath(new URL('./egglog/run.py', import.meta.url));
const positive = (value, name, maximum) => {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new RangeError(`${name} must be an integer in 1–${maximum}.`);
  return value;
};

export function optimizeGraph(input, {
  python = process.env.MOONWEAVE_EGGLOG_PYTHON || 'python3',
  iterations = 12, rows = 50000, timeoutMs = 30000,
} = {}) {
  positive(iterations, 'iterations', 100);
  positive(rows, 'rows', 1000000);
  positive(timeoutMs, 'timeoutMs', 60000);
  const graph = materialGraph(input), job = createOptimizationJob(graph);
  const response = execFileSync(python, [driver, '--iterations', String(iterations), '--rows', String(rows)], {
    input: JSON.stringify(job), encoding: 'utf8', timeout: timeoutMs,
    maxBuffer: GRAPH_LIMITS.jsonBytes, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const candidate = JSON.parse(response), result = applyOptimization(graph, candidate);
  return {job, candidate, result};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    python: {type: 'string'}, iterations: {type: 'string'}, rows: {type: 'string'},
    'timeout-ms': {type: 'string'}, artifacts: {type: 'string'}, help: {type: 'boolean'},
  }});
  if (values.help || positionals.length !== 2) {
    process.stdout.write('Usage: node tools/optimize-graph.mjs input.json output.json [--python PATH] [--artifacts DIR]\n'
      + '       [--iterations 12] [--rows 50000] [--timeout-ms 30000]\n');
    process.exit(values.help ? 0 : 2);
  }
  const [inputPath, outputPath] = positionals.map(path => resolve(path));
  if (inputPath === outputPath) throw new Error('Use a distinct output path to retain the authored graph.');
  const artifactDirectory = values.artifacts ? resolve(values.artifacts) : undefined;
  const artifacts = artifactDirectory && Object.fromEntries(['job', 'candidate', 'receipt']
    .map(name => [name, resolve(artifactDirectory, name + '.json')]));
  if (artifacts && Object.values(artifacts).some(path => path === inputPath || path === outputPath)) {
    throw new Error('Artifact paths must be distinct from the input and output graph paths.');
  }
  const text = readFileSync(inputPath, 'utf8');
  const options = {python: values.python};
  for (const [flag, key] of [['iterations', 'iterations'], ['rows', 'rows'], ['timeout-ms', 'timeoutMs']]) {
    if (values[flag] !== undefined) options[key] = Number(values[flag]);
  }
  const {job, candidate, result} = optimizeGraph(parseGraph(text), options);
  const {graph, ...decision} = result;
  const receipt = {...decision,
    sourceSha256: createHash('sha256').update(text).digest('hex'), engine: candidate.receipt};
  mkdirSync(dirname(outputPath), {recursive: true});
  writeFileSync(outputPath, serializeGraph(graph));
  if (artifacts) {
    mkdirSync(artifactDirectory, {recursive: true});
    for (const [name, value] of Object.entries({job, candidate, receipt})) {
      writeFileSync(artifacts[name], JSON.stringify(value, null, 2) + '\n');
    }
  }
  process.stdout.write(JSON.stringify({input: inputPath, output: outputPath, ...receipt}, null, 2) + '\n');
}
