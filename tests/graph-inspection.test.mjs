import test from 'node:test';
import assert from 'node:assert/strict';
import {scalar, color, surface, named, materialGraph, inspectGraph, compileGraph, patchGraph} from '../src/core.mjs';
import {layoutGraph} from '../lab/graph-layout.mts';

const material=field=>surface.channels(surface.material(color.linear([.2,.4,.6])),{roughness:field});

test('inspection exposes actual shared compiled representatives and ordered typed ports',()=>{
  const gain=named('gain',scalar.parameter(.7));
  const a=named('leftHeight',scalar.multiply(named('leftAxis',scalar.axis('x')),gain));
  const b=named('rightHeight',scalar.multiply(named('rightAxis',scalar.axis('x')),gain));
  const graph=materialGraph(material(scalar.add(a,b))),plan=compileGraph(graph),view=inspectGraph(graph);
  const bySource=id=>view.nodes.find(node=>node.sources.includes(id));
  assert.equal(bySource('leftHeight'),bySource('rightHeight'));
  assert.equal(bySource('leftAxis'),bySource('rightAxis'));
  assert.equal(view.statistics.aliases,2);
  assert.equal(view.nodes.length,plan.nodes.length);
  assert.equal(view.nodes[view.output].id,plan.output);
  assert.equal(view.edges.length,view.statistics.edges);
  for(const edge of view.edges)assert(edge.source<edge.target);
  assert.deepEqual(bySource('gain').sources,['gain']);
  assert(Object.isFrozen(view.nodes));assert(Object.isFrozen(view.edges));
  const layout=layoutGraph(view);
  for(const edge of view.edges)assert(layout.positions[edge.source].x<layout.positions[edge.target].x);
});

test('folded children have no false live alias and unreachable authored values remain addressable',()=>{
  const halfA=named('halfA',scalar.constant(.5)),halfB=named('halfB',scalar.constant(.5));
  const graph=materialGraph(material(named('sum',scalar.add(halfA,halfB))));
  const withUnused=materialGraph({...graph,nodes:[...graph.nodes,{id:'unused',kind:'parameter',value:.4}]});
  const view=inspectGraph(withUnused);
  assert(view.eliminated.includes('halfA'));assert(view.eliminated.includes('halfB'));assert(view.eliminated.includes('unused'));
  assert(!view.nodes.some(node=>node.sources.includes('halfA')||node.sources.includes('halfB')));
  assert(view.nodes.some(node=>node.sources.includes('sum')));
  assert.equal(patchGraph(withUnused,{unused:{value:.8}}).nodes.find(node=>node.id==='unused').value,.8);
});

test('inspection shares immutable topology across value edits while equal named controls remain distinct',()=>{
  const a=named('first',scalar.parameter(.5)),b=named('second',scalar.parameter(.5));
  const graph=materialGraph(material(scalar.multiply(a,b))),before=inspectGraph(graph);
  const first=before.nodes.findIndex(node=>node.sources.includes('first'));
  const second=before.nodes.findIndex(node=>node.sources.includes('second'));
  assert.notEqual(first,second);
  const changed=patchGraph(graph,{first:{value:.2}});
  assert.equal(inspectGraph(changed),before);
  assert.equal(compileGraph(changed).structure,compileGraph(graph).structure);
  assert.equal(inspectGraph(graph),before);
});
