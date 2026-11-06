import test from 'node:test';
import assert from 'node:assert/strict';
import {bakeMeshFlow, guidedStrokes, markProgram, bakeMarks, applyMarkBake,
  image, materialGraph, surface, serializeGraph, serializeMarkProgram, parseMarkProgram} from '../src/core.mjs';

test('geometry-guided strokes lower through the ordinary portable mark program', () => {
  const positions=[0,0,0,1,0,0,0,1,0,1,1,0];
  const uv=[0,0,1,0,0,1,1,1];
  const foldGuides=[1,0,0,0,1,0,1,0,0,0,1,0];
  const atlas=bakeMeshFlow({positions,uv,foldGuides,indices:[0,1,3,0,3,2]},{width:64,height:64});
  const marks=guidedStrokes(atlas,{seeds:[[.16,.2],[.7,.7]],brush:'bristle',color:[.65,.45,.2],radius:.035,length:.18,step:.005});
  const tip=image.generate({width:16,height:16,channels:1},(u,v)=>Math.max(0,1-Math.hypot(u-.5,v-.5)*2)).resource;
  const program=markProgram({brushes:{bristle:{mask:tip}},marks});
  const parsed=parseMarkProgram(serializeMarkProgram(program));
  assert.equal(parsed.marks.length,2);
  assert.equal(parsed.marks[0].kind,'stroke');
  const bake=bakeMarks(parsed,{width:32,height:32,samples:2});
  assert.ok(bake.coverage.data.some(v=>v>0));
  const graph=materialGraph(applyMarkBake(surface.paint('carapace'),bake));
  const json=serializeGraph(graph);
  assert.ok(json.includes('image'));
  assert.ok(!json.includes('foldGuides'),'mesh authoring inputs are absent from runtime graph');
});