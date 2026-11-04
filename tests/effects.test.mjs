import test from 'node:test';
import assert from 'node:assert/strict';
import {SURFACE_SIGNATURE} from '../src/core/algebra.mts';
import {
  EFFECT_CHANNELS, EFFECT_OPERATORS, SURFACE_EFFECTS, EXACT_EFFECT_RULES, projectSurfaceTerms,
} from '../src/core/effects.mts';

const term = (op, ...args) => ({op, args});
const components = ['color', 'slope', ...EFFECT_CHANNELS];
const channelOf = op => EFFECT_OPERATORS[op].channel;

function termsFor(expression, variables, sources = {}) {
  const terms = [], memo = new Map();
  function visit(value) {
    const key = JSON.stringify(value);
    if (memo.has(key)) return memo.get(key);
    const body = typeof value === 'string'
      ? {op: `${variables[value][0].toUpperCase()}${variables[value].slice(1)}Atom`, source: sources[value] ?? value}
      : {op: value.op, args: value.args.map(visit)};
    const id = `t${terms.length}`;
    terms.push({id, ...body});
    memo.set(key, id);
    return id;
  }
  const output = visit(expression);
  return {terms, output};
}

function projection(expression, variables, intern, sources) {
  const {terms, output} = termsFor(expression, variables, sources);
  return projectSurfaceTerms(terms, output, intern);
}

test('effect operators derive graph sorts and ports, and every equation is closed and typed', () => {
  assert.deepEqual(EFFECT_CHANNELS, SURFACE_SIGNATURE.channels.ports.values.keys);
  for (const operator of Object.values(EFFECT_OPERATORS)) {
    assert(Object.isFrozen(operator));
    assert(Object.isFrozen(operator.inputs));
    if (operator.atom) {
      assert.deepEqual(operator.inputs, []);
    } else if (operator.kind === 'channels') {
      assert(EFFECT_CHANNELS.includes(operator.channel));
      assert.deepEqual(operator.ports, ['input', 'value']);
      assert.deepEqual(operator.inputs, ['surface', 'scalar']);
    } else {
      const signature = SURFACE_SIGNATURE[operator.kind];
      assert.equal(operator.result, signature.result);
      assert.deepEqual(operator.ports, signature.portEntries.map(([key]) => key));
      assert.deepEqual(operator.inputs, signature.portEntries.map(([, port]) => port.sort));
    }
  }
  assert.equal(EXACT_EFFECT_RULES.length, 24);
  assert.equal(new Set(EXACT_EFFECT_RULES.map(rule => rule.id)).size, 24);
  for (const rule of EXACT_EFFECT_RULES) {
    const used = new Set();
    function sort(value) {
      if (typeof value === 'string') {
        assert(Object.hasOwn(rule.variables, value), `${rule.id}: undeclared ${value}`);
        used.add(value);
        return rule.variables[value];
      }
      const operator = EFFECT_OPERATORS[value.op];
      assert(operator && !operator.atom, `${rule.id}: invalid equation constructor`);
      assert.equal(value.args.length, operator.inputs.length);
      assert.deepEqual(value.args.map(sort), operator.inputs, rule.id);
      return operator.result;
    }
    assert.equal(sort(rule.left), 'surface');
    assert.equal(sort(rule.right), 'surface');
    assert.equal(used.size, Object.keys(rule.variables).length);
  }
  assert.deepEqual(SURFACE_EFFECTS.coat, {reads: ['color'], writes: ['color']});
  assert.deepEqual(SURFACE_EFFECTS.bump.writes, ['slope']);
  assert.deepEqual(SURFACE_EFFECTS.relief.writes, ['slope']);
  assert.equal(SURFACE_EFFECTS.channels.selected, true);
});

test('all declared laws have identical six-component symbolic observations', () => {
  for (const rule of EXACT_EFFECT_RULES) {
    const intern = new Map();
    const left = projection(rule.left, rule.variables, intern);
    const right = projection(rule.right, rule.variables, intern);
    assert.deepEqual(Object.keys(left), components);
    assert.deepEqual(left, right, rule.id);
  }
});

// A separate numerical record interpretation follows shader component writes.
// Its explicit f32 operations make intermediate rounding visible; it is not a
// lighting renderer or an assertion about a driver's contraction of GLSL mix.
const f32 = Math.fround;
const clamp = value => Math.max(0, Math.min(1, value));
const mix = (a, b, mask) => f32(f32(a * f32(1 - mask)) + f32(b * mask));
function observe(expression, variables) {
  if (typeof expression === 'string') return variables[expression];
  const [s, a, b] = expression.args.map(value => observe(value, variables));
  const channel = channelOf(expression.op);
  if (channel) return {...s, [channel]: clamp(a.value)};
  switch (expression.op) {
    case 'Coat': return {...s, color: s.color.map((value, index) => mix(value, clamp(a[index]), clamp(b.value)))};
    case 'Bump': return {...s, slope: [f32(s.slope[0] + a.dx), f32(s.slope[1] + a.dy)]};
    case 'Relief': return {...s, slope: s.slope.map(value => f32(value * a.value))};
    case 'Mix': return Object.fromEntries(components.map(component => [component,
      Array.isArray(s[component]) ? s[component].map((value, index) => mix(value, a[component][index], clamp(b.value)))
        : mix(s[component], a[component], clamp(b.value)),
    ]));
    default: throw new TypeError(`Unexpected numerical effect: ${expression.op}.`);
  }
}

test('effect laws preserve every f32 component across clamp boundaries and seeded finite contexts', () => {
  let seed = 0x57c0a7;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 2 ** 32;
  };
  const edges = [-1e20, -2, -1, -1e-20, -0, 0, 1e-20, .137, .5, .99999994, 1, 2, 1e20].map(f32);
  for (let index = 0; index < 256; index++) {
    const scalar = offset => ({
      value: index < edges.length * 2 ? edges[(index + offset) % edges.length] : f32(random() * 4 - 2),
      dx: f32((random() * 2 - 1) * (index % 3 ? 1e-15 : 1e15)),
      dy: f32((random() * 2 - 1) * (index % 3 ? 1e15 : 1e-15)),
    });
    const s = {
      color: [0, 1, 2].map(offset => clamp(scalar(offset).value)),
      slope: [f32((random() - .5) * 1e15), f32((random() - .5) * 1e-15)],
      ...Object.fromEntries(EFFECT_CHANNELS.map((channel, offset) => [channel, clamp(scalar(offset + 3).value)])),
    };
    const values = {s, x: scalar(1), y: scalar(5), h: scalar(7), k: scalar(9), m: scalar(11),
      c: [scalar(2).value, scalar(6).value, scalar(10).value]};
    for (const rule of EXACT_EFFECT_RULES) {
      const left = observe(rule.left, values), right = observe(rule.right, values);
      assert.deepEqual(left, right, `${rule.id}, context ${index}`);
      assert(Object.values(left).flat().every(Number.isFinite), `${rule.id}: finite witness`);
    }
  }
});

test('the projector rejects ordering changes within a color or slope component', () => {
  const variables = {s: 'surface', c: 'color', d: 'color', m: 'scalar', n: 'scalar', h: 'scalar', k: 'scalar'};
  const pairs = [
    [term('Relief', term('Bump', 's', 'h'), 'k'), term('Bump', term('Relief', 's', 'k'), 'h')],
    [term('Bump', term('Bump', 's', 'h'), 'k'), term('Bump', term('Bump', 's', 'k'), 'h')],
    [term('Coat', term('Coat', 's', 'c', 'm'), 'd', 'n'), term('Coat', term('Coat', 's', 'd', 'n'), 'c', 'm')],
    [term('Mix', term('Roughness', 's', 'h'), term('Roughness', 's', 'h'), 'm'), term('Roughness', 's', 'h')],
  ];
  for (const [left, right] of pairs) {
    const intern = new Map();
    assert.notDeepEqual(projection(left, variables, intern), projection(right, variables, intern));
  }
  const s = {color: [.2, .3, .4], slope: [f32(1e20), 0], roughness: .5, metalness: 0, clearcoat: 0, opacity: 1};
  const values = {s, h: {value: 0, dx: f32(-1e20), dy: 0}, k: {value: 2, dx: 1, dy: 0}};
  assert.notDeepEqual(observe(pairs[0][0], values), observe(pairs[0][1], values));
  assert.notDeepEqual(observe(pairs[1][0], values), observe(pairs[1][1], values));
});

test('shadowed writes disappear only from their consumer; shared branches and source identities survive', () => {
  const variables = {s: 'surface', x: 'scalar', y: 'scalar', h: 'scalar', m: 'scalar'};
  const inner = term('Roughness', 's', 'x');
  const original = term('Mix', inner, term('Roughness', term('Bump', inner, 'h'), 'y'), 'm');
  const candidate = term('Mix', inner, term('Roughness', term('Bump', 's', 'h'), 'y'), 'm');
  const wrong = term('Mix', term('Roughness', 's', 'y'), term('Roughness', term('Bump', 's', 'h'), 'y'), 'm');
  const intern = new Map();
  assert.deepEqual(projection(original, variables, intern), projection(candidate, variables, intern));
  assert.notDeepEqual(projection(original, variables, intern), projection(wrong, variables, intern));
  assert.notDeepEqual(projection(original, variables, intern),
    projection(original, variables, intern, {x: 'independently-editable-x'}));

  const hidden = term('Roughness', term('Bump', inner, 'h'), 'y');
  assert.deepEqual(projection(hidden, variables, intern),
    projection(hidden, variables, intern, {x: 'edited-hidden-source'}));
  assert.notDeepEqual(projection(inner, variables, intern),
    projection(inner, variables, intern, {x: 'edited-hidden-source'}));
});

test('projection requires known topological terms and a surface result', () => {
  assert.throws(() => projectSurfaceTerms([{id: 'a', op: 'Bump', args: ['missing', 'height']}], 'a', new Map()), /topologically available/);
  assert.throws(() => projectSurfaceTerms([{id: 'a', op: 'Unknown', args: []}], 'a', new Map()), /Unknown surface effect/);
  assert.throws(() => projectSurfaceTerms([{id: 'a', op: 'ScalarAtom', source: 'height'}], 'a', new Map()), /surface root/);
});
