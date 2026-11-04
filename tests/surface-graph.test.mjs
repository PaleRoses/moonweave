import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scalar,color,domain,facets,surface,named,splitRecipe,materialGraph,patchGraph,compileGraph,
  serializeGraph,parseGraph,evaluateScalar,evaluateDomain,GRAPH_LIMITS,
} from '../src/core.mjs';
import {normalizeFacetMapping,normalizePaintStyle,normalizeSurfaceRecipe} from '../src/core.mjs';

const copy=value=>JSON.parse(JSON.stringify(value));
const close=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance,`${a} differs from ${b}`);
const scalarGraph=field=>materialGraph(surface.channels(surface.paint(),{roughness:field}));
const scalarRoot=graph=>graph.nodes.find(n=>n.id===graph.output).values.roughness;
const sample=(field,context={})=>{const graph=scalarGraph(field);return evaluateScalar(graph,scalarRoot(graph),context);};
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];

test('trusted immutable graphs and compiled plans preserve identity at repeated boundaries',()=>{
  const expression=surface.paint('horn'),graph=materialGraph(expression);
  assert.equal(materialGraph(expression),graph);
  assert.equal(materialGraph(graph),graph);
  const plan=compileGraph(graph);
  assert.equal(compileGraph(graph),plan);
  assert.equal(compileGraph(expression),plan);
  assert.equal(materialGraph(plan.graph),graph);
  const foreign=Object.freeze(copy(graph));
  assert.notEqual(materialGraph(foreign),foreign);
  const mutable=copy(graph),first=materialGraph(mutable);
  mutable.nodes[0].scale=.33;
  const revised=materialGraph(mutable);
  assert.notEqual(revised,first);
  assert.equal(revised.nodes[0].scale,.33);
  const invalid=copy(graph);invalid.nodes[0].scale=0;
  Object.freeze(invalid);
  assert.throws(()=>materialGraph(invalid),/scale/);
});

test('mapping and paint style normalize independently without rebuilding a recipe',()=>{
  const raw={scale:.2,stretch:[1,2,3],rotation:-13};
  const mapping=normalizeFacetMapping(raw);
  assert.equal(normalizeFacetMapping(mapping),mapping);
  assert.equal(mapping.rotation,347);
  assert.equal(mapping.palette,undefined);
  raw.stretch[1]=9;
  assert.equal(mapping.stretch[1],2);
  assert.equal(Object.isFrozen(raw),false);
  const style=normalizePaintStyle({roughness:.4});
  assert.equal(normalizePaintStyle(style),style);
  assert.equal(style.roughness,.4);
  assert.equal(style.palette,undefined);
  assert.equal(style.scale,undefined);
  assert.throws(()=>normalizePaintStyle({scale:1}),/Unknown/);
  assert.throws(()=>normalizePaintStyle({palette:{base:'#ABCDEF'}}),/Unknown/);
  assert.throws(()=>normalizeFacetMapping({palette:{base:'#ffffff'}}),/Unknown/);
  const recipe=normalizeSurfaceRecipe('horn');
  assert.equal(normalizeSurfaceRecipe(recipe),recipe);
  assert.equal(splitRecipe(recipe),splitRecipe(recipe));
});

test('persistent value patches share nodes and compiled structure and merge only requested style values',()=>{
  const frame=domain.transform(identity),field=facets({domain:frame});
  const mask=scalar.multiply(scalar.parameter(.4),scalar.ramp(scalar.facing([0,1,0],frame),-.3,.6));
  const graph=materialGraph(surface.mix(surface.paint(field,'carapace'),surface.paint(field,'horn'),mask));
  const paint=graph.nodes.find(node=>node.kind==='paint'),mapping=graph.nodes.find(node=>node.kind==='facets');
  const patch={
    [paint.id]:{style:{roughness:.61}},
    [paint.palette.base]:{value:[...color.srgb('#123456').value]},
    [mapping.id]:{scale:.32},
  };
  const before=serializeGraph(graph),plan=compileGraph(graph),next=patchGraph(graph,patch),updated=compileGraph(next);
  assert.notEqual(next,graph);
  assert.equal(materialGraph(next),next);
  assert.equal(updated.structure,plan.structure);
  assert.equal(updated.bindings,plan.bindings);
  assert.equal(updated.cost,plan.cost);
  assert.equal(updated.programKey,plan.programKey);
  for(let index=0;index<graph.nodes.length;index++) {
    const node=graph.nodes[index],changed=Object.hasOwn(patch,node.id);
    assert.equal(next.nodes[index]===node,!changed);
  }
  for(const binding of plan.bindings) {
    assert.equal(plan.nodes[binding.index].id,binding.nodeId);
    const changed=Object.hasOwn(patch,binding.sourceId);
    assert.equal(updated.nodes[binding.index]===plan.nodes[binding.index],!changed);
  }
  const style=next.nodes.find(node=>node.id===paint.id).style;
  assert.equal(next.nodes.find(node=>node.id===paint.id).palette.shadow,paint.palette.shadow);
  assert.equal(style.clearcoat,paint.style.clearcoat);
  patch[paint.palette.base].value[0]=1;
  assert.deepEqual(next.nodes.find(node=>node.id===paint.palette.base).value,color.srgb('#123456').value);
  assert.equal(Object.isFrozen(patch),false);
  assert.equal(serializeGraph(graph),before);
  assert(Object.isFrozen(plan.structure));assert(Object.isFrozen(plan.bindings));
  assert(plan.bindings.every(Object.isFrozen));
});

test('no-op patches preserve graph and plan identity; structural edits use a new graph',()=>{
  const graph=materialGraph(surface.paint('moonstone')),plan=compileGraph(graph);
  const field=graph.nodes.find(node=>node.kind==='facets'),paint=graph.nodes.find(node=>node.kind==='paint');
  assert.equal(patchGraph(graph,{}),graph);
  assert.equal(patchGraph(graph,{[field.id]:{scale:field.scale,rotation:field.rotation+360}}),graph);
  const pigment=graph.nodes.find(node=>node.id===paint.palette.base);
  assert.equal(patchGraph(graph,{[pigment.id]:{value:[...pigment.value]}}),graph);
  assert.equal(compileGraph(patchGraph(graph,{[paint.id]:{}})),plan);
  assert.throws(()=>patchGraph(graph,{[field.id]:{domain:'other'}}),/Unknown/);
  assert.throws(()=>patchGraph(graph,{[paint.id]:{field:field.id}}),/Unknown/);
  const scalarDoc=scalarGraph(scalar.add(scalar.axis(),1));
  const literal=scalarDoc.nodes.find(node=>node.kind==='constant');
  assert.throws(()=>patchGraph(scalarDoc,{[literal.id]:{value:2}}),/structural/);
  assert.notEqual(compileGraph(copy(graph)).structure,plan.structure);
  assert.equal(compileGraph(copy(graph)).programKey,plan.programKey);
});

test('patch validation is atomic and preserves numerical and schema bounds',()=>{
  const frame=domain.transform(identity),field=facets({domain:frame});
  const graph=materialGraph(surface.channels(surface.paint(field),{roughness:scalar.ramp(scalar.axis(),0,1)}));
  const plan=compileGraph(graph),before=serializeGraph(graph);
  const id=kind=>graph.nodes.find(node=>node.kind===kind).id;
  const invalids=[
    {[id('facets')]:{scale:0}},
    {[id('paint')]:{style:{palette:null}}},
    {[id('paint')]:{style:{roughness:2}}},
    {[id('color')]:{value:[NaN,0,0]}},
    {[id('ramp')]:{low:1e9,high:1e9+1}},
    {[id('transform')]:{matrix:identity.map((value,index)=>index===0?0:value)}},
    {missing:{value:.2}},
  ];
  for(const invalid of invalids) {
    assert.throws(()=>patchGraph(graph,{[id('facets')]:{scale:.3},...invalid}));
    assert.equal(serializeGraph(graph),before);
    assert.equal(compileGraph(graph),plan);
  }
});

test('value revisions update opacity analysis while dead edits reuse every live binding',()=>{
  const field=facets();
  const raw=copy(materialGraph(surface.mix(surface.paint(field),surface.paint(field,{opacity:.25}),scalar.parameter(0))));
  raw.nodes.push({id:'unused',kind:'parameter',value:.2});
  const graph=materialGraph(raw),plan=compileGraph(graph);
  const weight=graph.nodes.find(node=>node.kind==='parameter'&&node.id!=='unused');
  const next=compileGraph(patchGraph(graph,{[weight.id]:{value:1}}));
  assert.equal(next.structure,plan.structure);
  assert.deepEqual(plan.opacityRange,[1,1]);
  assert.deepEqual(next.opacityRange,[.25,.25]);
  assert(!plan.bindings.some(binding=>binding.sourceId==='unused'));
  const dead=compileGraph(patchGraph(graph,{unused:{value:.7}}));
  assert.notEqual(dead.graph,graph);
  assert.equal(dead.structure,plan.structure);
  assert(dead.nodes.every((node,index)=>node===plan.nodes[index]));
});

test('reused structures still check arithmetic and composed domain bounds after value edits',()=>{
  const graph=scalarGraph(scalar.multiply(scalar.parameter(1e10),scalar.parameter(1e10)));
  const plan=compileGraph(graph);
  const changes=Object.fromEntries(graph.nodes.filter(node=>node.kind==='parameter').map(node=>[node.id,{value:1e20}]));
  assert.throws(()=>compileGraph(patchGraph(graph,changes)),/float32/);
  assert.equal(compileGraph(graph),plan);
  const scaled=amount=>identity.map((value,index)=>[0,5,10].includes(index)?amount:value);
  const frame=domain.transform(scaled(1e10),domain.transform(scaled(1e10)));
  const transformed=materialGraph(surface.paint('horn',{domain:frame}));
  const original=compileGraph(transformed);
  const matrices=Object.fromEntries(transformed.nodes.filter(node=>node.kind==='transform').map(node=>[node.id,{matrix:scaled(1e20)}]));
  assert.throws(()=>compileGraph(patchGraph(transformed,matrices)),/Composed domain/);
  assert.equal(compileGraph(transformed),original);
});

test('appearance edits preserve analyzed intervals and do not recheck unchanged coordinate domains',()=>{
  const graph=materialGraph({version:1,nodes:[
    {id:'parent',kind:'transform',matrix:identity},
    {id:'child',kind:'transform',matrix:identity,input:'parent'},
    {id:'field',kind:'facets',domain:'child'},
    {id:'skin',kind:'paint',field:'field'},
    {id:'pale',kind:'paint',field:'field',style:{opacity:.25}},
    {id:'amount',kind:'parameter',value:.2},
    {id:'weight',kind:'ramp',input:'amount',low:0,high:1},
    {id:'result',kind:'mix',a:'skin',b:'pale',mask:'weight'},
  ],output:'result'});
  const initial=compileGraph(graph);
  const appearance=patchGraph(graph,{skin:{style:{roughness:.3}},field:{scale:.4}});
  const fround=Math.fround;let rounded=0,updated;
  Math.fround=value=>{rounded++;return fround(value);};
  try {updated=compileGraph(appearance);}finally {Math.fround=fround;}
  assert.equal(rounded,0);
  assert.equal(updated.opacityRange,initial.opacityRange);
  for(const id of Object.keys(initial.ranges))assert.equal(updated.ranges[id],initial.ranges[id]);
  const weighted=patchGraph(appearance,{amount:{value:.8}}),weightPlan=compileGraph(weighted);
  close(weightPlan.opacityRange[0],.328);
  const translucent=patchGraph(weighted,{skin:{style:{opacity:.5}}}),translucentPlan=compileGraph(translucent);
  close(translucentPlan.opacityRange[0],.276);
  const widened=patchGraph(translucent,{weight:{high:2}}),widePlan=compileGraph(widened);
  close(widePlan.opacityRange[0],.412);
  // Revisiting an older branch must compare all child inputs, not a revision counter.
  const branch=patchGraph(graph,{skin:{style:{contrast:.12}}});
  for(const candidate of [branch,weighted,translucent,widened]) {
    const actual=compileGraph(candidate),fresh=compileGraph(copy(candidate));
    assert.deepEqual(actual.ranges,fresh.ranges);
    assert.deepEqual(actual.opacityRange,fresh.opacityRange);
  }
});

test('changed ancestors invalidate unchanged descendants and failed analysis cannot poison another branch',()=>{
  const scaled=amount=>identity.map((value,index)=>[0,5,10].includes(index)?amount:value);
  const graph=materialGraph({version:1,nodes:[
    {id:'parent',kind:'transform',matrix:scaled(1e10)},
    {id:'child',kind:'transform',matrix:scaled(1e20),input:'parent'},
    {id:'field',kind:'facets',domain:'child'},
    {id:'skin',kind:'paint',field:'field'},
  ],output:'skin'});
  const original=compileGraph(graph);
  const invalid=patchGraph(graph,{parent:{matrix:scaled(1e20)}});
  assert.equal(invalid.nodes.find(node=>node.id==='child'),graph.nodes.find(node=>node.id==='child'));
  assert.throws(()=>compileGraph(invalid),/Composed domain/);
  const recovered=patchGraph(graph,{parent:{matrix:scaled(1e12)}});
  assert.doesNotThrow(()=>compileGraph(recovered));
  assert.throws(()=>compileGraph(invalid),/Composed domain/);
  const branch=compileGraph(patchGraph(graph,{skin:{style:{roughness:.42}}}));
  assert.deepEqual(branch.opacityRange,original.opacityRange);
  assert.equal(branch.programKey,original.programKey);

  const arithmetic=scalarGraph(scalar.multiply(scalar.parameter(1e20),scalar.parameter(1e10)));
  compileGraph(arithmetic);
  const small=arithmetic.nodes.find(node=>node.kind==='parameter'&&node.value===1e10);
  assert.throws(()=>compileGraph(patchGraph(arithmetic,{[small.id]:{value:1e20}})),/float32/);
  const safe=compileGraph(patchGraph(arithmetic,{[small.id]:{value:1e12}}));
  assert.deepEqual(safe.ranges[safe.nodes.find(node=>node.kind==='multiply').id],[1e32,1e32]);
});

test('scalar evaluation reuses immutable domains without retaining stale values or sample state',()=>{
  const matrix=[...identity];matrix[0]=2;
  const graph=scalarGraph(scalar.axis('x',domain.transform(matrix)));
  const id=scalarRoot(graph),transform=graph.nodes.find(node=>node.kind==='transform');
  assert.equal(evaluateScalar(graph,id,{position:[3,0,0]}).value,6);
  assert.equal(evaluateScalar(graph,id,{position:[4,0,0]}).value,8);
  const replacement=[...matrix];replacement[0]=3;
  const changed=patchGraph(graph,{[transform.id]:{matrix:replacement}});
  assert.equal(evaluateScalar(changed,id,{position:[3,0,0]}).value,9);
  assert.equal(evaluateScalar(graph,id,{position:[3,0,0]}).value,6);
});

test('expression constructors separate sampling from style and preserve intentional sharing',()=>{
  const field=facets({scale:.22});
  const graph=materialGraph(surface.mix(surface.paint(field,'carapace'),surface.paint(field,'horn'),scalar.parameter(.5)));
  assert.equal(graph.nodes.filter(n=>n.kind==='facets').length,1);
  const paints=graph.nodes.filter(n=>n.kind==='paint');
  assert.equal(paints[0].field,paints[1].field);
  assert.notDeepEqual(paints[0].palette,paints[1].palette);
  assert.equal(compileGraph(graph).cost.textureReads,4);
  assert(Object.isFrozen(graph));assert(Object.isFrozen(graph.nodes));
  assert(Object.isFrozen(paints[0].palette));
  const independent=materialGraph(surface.mix(surface.paint('carapace'),surface.paint('carapace'),scalar.parameter(.5)));
  assert.equal(compileGraph(independent).cost.paintSamples,2);
});

test('recipes lower coordinates into facets, numeric controls into style and colors into palette inputs',()=>{
  const parts=splitRecipe('horn'),graph=materialGraph(surface.paint('horn'));
  const field=graph.nodes.find(n=>n.kind==='facets'),paint=graph.nodes.find(n=>n.kind==='paint');
  for(const [key,value] of Object.entries(parts.mapping))assert.deepEqual(field[key],value);
  assert.deepEqual(paint.style,parts.style);
  for(const role of ['base','shadow','light']) {
    assert.deepEqual(graph.nodes.find(node=>node.id===paint.palette[role]).value,parts.palette[role].value);
  }
  assert.equal(paint.style.scale,undefined);
  assert.equal(field.palette,undefined);
});

test('normalized documents and canonical serialization round-trip without mutating inputs',()=>{
  const graph=materialGraph(surface.mix(surface.paint('moonstone'),surface.paint('velvet'),scalar.ramp(scalar.axis(),-.5,1)));
  const input=copy(graph),before=copy(input);
  input.nodes.reverse();
  const serial=serializeGraph(input);
  assert.equal(serializeGraph(parseGraph(serial)),serial);
  assert.deepEqual(materialGraph(input),before);
  assert.equal(input.nodes[0].id,before.nodes.at(-1).id);
  const facing=scalarGraph(scalar.facing([7,3,1]));
  assert.equal(serializeGraph(parseGraph(serializeGraph(facing))),serializeGraph(facing));
});

test('uniform edits preserve the full structural program key; literal choices specialize',()=>{
  const field=facets();
  const graph=materialGraph(surface.mix(surface.paint(field,'carapace'),surface.paint(field,'horn'),scalar.parameter(0)));
  const changed=copy(graph);
  changed.nodes.find(n=>n.kind==='parameter').value=1;
  changed.nodes.find(n=>n.kind==='facets').scale=.8;
  const paint=changed.nodes.find(n=>n.kind==='paint');
  changed.nodes.find(n=>n.id===paint.palette.base).value=color.srgb('#808080').value;
  assert.equal(compileGraph(graph).programKey,compileGraph(changed).programKey);
  assert.equal(compileGraph(changed).nodes.filter(n=>n.kind==='paint').length,2);
  const left=surface.paint('carapace'),right=surface.paint('horn');
  const a=compileGraph(surface.mix(left,right,scalar.constant(0)));
  const b=compileGraph(surface.mix(left,right,scalar.constant(1)));
  assert.equal(a.nodes.filter(n=>n.kind==='paint').length,1);
  assert.equal(b.nodes.filter(n=>n.kind==='paint').length,1);
  // Both resulting single-paint programs can share code even though their uniforms differ.
  assert.equal(a.programKey,b.programKey);
  const fieldGraph=scalarGraph(scalar.add(scalar.axis('x'),scalar.constant(1)));
  const literalChanged=copy(fieldGraph);literalChanged.nodes.find(n=>n.kind==='constant').value=2;
  assert.notEqual(compileGraph(fieldGraph).programKey,compileGraph(literalChanged).programKey);
});

test('literal scalar algebra folds and removes dead work but editable zero does not',()=>{
  const folded=compileGraph(scalarGraph(scalar.add(scalar.multiply(2,3),4)));
  assert.deepEqual(folded.nodes.filter(n=>n.kind==='constant').map(n=>n.value),[10]);
  assert(!folded.nodes.some(n=>n.kind==='multiply'||n.kind==='add'));
  const live=compileGraph(scalarGraph(scalar.multiply(scalar.parameter(0),scalar.axis('x'))));
  assert(live.nodes.some(n=>n.kind==='multiply'));
  assert(live.nodes.some(n=>n.kind==='axis'));
  assert.deepEqual(live.ranges[scalarRoot({nodes:live.nodes,output:live.output})],[0,0]);
  const dead=compileGraph(scalarGraph(scalar.multiply(scalar.constant(0),scalar.axis('x'))));
  assert(!dead.nodes.some(n=>n.kind==='axis'));
});

test('CSE reuses equivalent referenced arithmetic but keeps independent parameters separate',()=>{
  const x=scalar.axis('x'),two=scalar.constant(2);
  const graph=scalarGraph(scalar.add(scalar.multiply(x,two),scalar.multiply(x,two)));
  assert.equal(compileGraph(graph).nodes.filter(n=>n.kind==='multiply').length,1);
  const independent=scalarGraph(scalar.add(scalar.parameter(.5),scalar.parameter(.5)));
  assert.equal(compileGraph(independent).nodes.filter(n=>n.kind==='parameter').length,2);
  const a=scalar.ramp(x,0,1),b=scalar.ramp(x,0,1);
  const ramps=scalarGraph(scalar.add(a,b));
  assert.equal(compileGraph(ramps).nodes.filter(n=>n.kind==='ramp').length,2);
  const changed=copy(ramps);changed.nodes.filter(n=>n.kind==='ramp')[1].high=2;
  assert.equal(compileGraph(ramps).programKey,compileGraph(changed).programKey);
});

test('optimization preserves observable cancellation instead of applying a real-number identity',()=>{
  const expression=scalar.multiply(scalar.complement(scalar.complement(scalar.parameter(1e-20))),1e20);
  const graph=scalarGraph(expression),plan=compileGraph(graph);
  const optimized={version:2,nodes:plan.nodes,output:plan.output};
  assert.equal(plan.nodes.filter(node=>node.kind==='complement').length,2);
  assert.equal(evaluateScalar(graph,scalarRoot(graph)).value,0);
  assert.equal(evaluateScalar(optimized,scalarRoot(optimized)).value,0);
});

test('surface identities eliminate whole unused samples and retain accurate live costs',()=>{
  const paint=surface.paint('moonstone');
  const simple=compileGraph(paint);
  const identityMix=compileGraph(surface.mix(paint,paint,scalar.ramp(scalar.axis('z'),0,1)));
  assert.equal(simple.programKey,identityMix.programKey);
  assert.deepEqual(simple.cost,identityMix.cost);
  assert.equal(compileGraph(surface.channels(paint,{})).programKey,simple.programKey);
  assert.equal(compileGraph(surface.relief(paint,1)).programKey,simple.programKey);
  const field=facets(),graph=materialGraph(surface.mix(surface.paint(field,'moonstone'),surface.paint(field,'horn'),scalar.parameter(.5)));
  const plan=compileGraph(graph);
  assert.equal(plan.cost.paintSamples,1);assert.equal(plan.cost.textureReads,4);
  assert.equal(plan.cost.uniformScalars,49);
});

test('channel overrides compose right-biased maps in one canonical channel order',()=>{
  const keys=['roughness','metalness','clearcoat','opacity'],paint=surface.paint('moonstone');
  const left=keys.map(()=>scalar.parameter(.2)),right=keys.map(()=>scalar.parameter(.8));
  // Every pair of channel subsets includes empty, disjoint and overlapping maps.
  for(let a=0;a<16;a++)for(let b=0;b<16;b++) {
    const inner=Object.fromEntries(keys.flatMap((key,i)=>a&(1<<i)?[[key,left[i]]]:[]));
    const outer=Object.fromEntries(keys.flatMap((key,i)=>b&(1<<i)?[[key,right[i]]]:[]).reverse());
    const nested=compileGraph(surface.channels(surface.channels(paint,inner),outer));
    const flat=compileGraph(surface.channels(paint,{...inner,...outer}));
    assert.equal(nested.programKey,flat.programKey,`channel subsets ${a}, ${b}`);
    assert.deepEqual(nested.nodes,flat.nodes);
    assert.deepEqual(nested.cost,flat.cost);
  }
});

test('nested channel overrides remove shadowed work while keeping the authored graph and live bindings',()=>{
  const shadow=named('shadow',scalar.parameter(.2));
  const ramp=named('shadow-ramp',scalar.ramp(scalar.axis('x'),0,1));
  const inner=named('inner',surface.channels(surface.paint(),{
    roughness:scalar.multiply(ramp,shadow),metalness:named('metal',scalar.parameter(.5)),opacity:shadow,
  }));
  const middle=surface.channels(inner,{roughness:named('rough',scalar.parameter(.5)),clearcoat:.3});
  const graph=materialGraph(surface.channels(middle,{opacity:named('alpha',scalar.parameter(1))}));
  const serialized=serializeGraph(graph),plan=compileGraph(graph);
  assert.equal(graph.nodes.length,16);assert.equal(plan.nodes.length,10);
  assert.equal(plan.nodes.filter(node=>node.kind==='channels').length,1);
  assert(!plan.nodes.some(node=>['axis','ramp','multiply'].includes(node.kind)));
  assert(!plan.bindings.some(binding=>['shadow','shadow-ramp'].includes(binding.sourceId)));
  assert.equal(plan.cost.uniformScalars,32);
  assert.deepEqual(plan.opacityRange,[1,1]);

  const edited=patchGraph(graph,{shadow:{value:.9},'shadow-ramp':{high:2}}),deadEdit=compileGraph(edited);
  assert.equal(deadEdit.structure,plan.structure);
  deadEdit.nodes.forEach((node,i)=>assert.equal(node,plan.nodes[i]));
  const updated=patchGraph(edited,{rough:{value:.7},metal:{value:.1},alpha:{value:.4}}),liveEdit=compileGraph(updated);
  assert.equal(liveEdit.structure,plan.structure);
  assert.deepEqual(liveEdit.opacityRange,[.4,.4]);
  const liveNodes=Object.fromEntries(liveEdit.bindings.map(binding=>[binding.sourceId,liveEdit.nodes[binding.index]]));
  assert.equal(liveNodes.rough.value,.7);assert.equal(liveNodes.metal.value,.1);assert.equal(liveNodes.alpha.value,.4);

  // Choosing the authored inner surface restores its values, including edits
  // made while the outer override kept them out of the execution plan.
  const revealed=materialGraph({...updated,output:'inner'}),revealedPlan=compileGraph(revealed);
  assert(revealedPlan.bindings.some(binding=>binding.sourceId==='shadow'));
  assert(revealedPlan.bindings.some(binding=>binding.sourceId==='shadow-ramp'));
  assert.deepEqual(revealedPlan.opacityRange,[.9,.9]);
  const roughness=revealed.nodes.find(node=>node.id==='inner').values.roughness;
  assert.equal(evaluateScalar(revealed,roughness,{position:[1,0,0]}).value,.45);
  assert.equal(serializeGraph(graph),serialized);
});

test('channel compaction preserves shared inner surfaces and independently editable equal values',()=>{
  const inner=surface.channels(surface.paint(),{roughness:named('inner-value',scalar.parameter(.5))});
  const outer=surface.channels(inner,{roughness:named('outer-value',scalar.parameter(.5))});
  const graph=materialGraph(surface.mix(inner,outer,scalar.parameter(.4))),plan=compileGraph(graph);
  const channels=plan.nodes.filter(node=>node.kind==='channels');
  assert.equal(channels.length,2);
  assert.equal(channels[0].input,channels[1].input);
  assert.notEqual(channels[0].values.roughness,channels[1].values.roughness);
  const changed=compileGraph(patchGraph(graph,{'inner-value':{value:.2}}));
  assert.equal(changed.structure,plan.structure);
  const values=new Map(changed.nodes.map(node=>[node.id,node.value]));
  assert.deepEqual(channels.map(node=>values.get(node.values.roughness)),[.2,.5]);
});

test('all imported nodes validate, even when unreachable',()=>{
  const graph=copy(materialGraph(surface.paint()));
  graph.nodes.push({id:'unused',kind:'parameter',value:.4});
  assert.equal(materialGraph(graph).nodes.length,6);
  assert.equal(compileGraph(graph).nodes.length,5);
  const invalids=[
    {id:'bad',kind:'facets',scale:0},
    {id:'bad',kind:'add',a:'missing',b:'missing'},
    {id:'bad',kind:'complement',input:graph.output},
    {id:'bad',kind:'parameter',value:NaN},
    {id:'bad',kind:'constant',value:1,callback:'hidden'},
  ];
  for(const node of invalids)assert.throws(()=>materialGraph({...graph,nodes:[...graph.nodes,node]}));
  assert.throws(()=>materialGraph({...graph,extra:true}));
  assert.throws(()=>materialGraph({...graph,version:3}));
  assert.throws(()=>materialGraph({...graph,nodes:[...graph.nodes,graph.nodes[0]]}));
});

test('cycles, graph size, depth, malformed domains and collapsed float32 ramps are rejected',()=>{
  const graph=copy(materialGraph(surface.paint()));
  assert.throws(()=>materialGraph({...graph,nodes:[...graph.nodes,{id:'cycle',kind:'complement',input:'cycle'}]}),/Cyclic/);
  let x=scalar.axis();for(let i=0;i<GRAPH_LIMITS.depth;i++)x=scalar.complement(x);
  assert.throws(()=>scalarGraph(x),/depth/);
  const extra=Array.from({length:GRAPH_LIMITS.nodes},(_,i)=>({id:`u${i}`,kind:'constant',value:i}));
  assert.throws(()=>materialGraph({...graph,nodes:[...graph.nodes,...extra]}),/nodes/);
  assert.throws(()=>parseGraph(' '.repeat(GRAPH_LIMITS.jsonBytes+1)),/size/);
  const singular=[...identity];singular[0]=0;
  const perspective=[...identity];perspective[3]=.1;
  for(const matrix of [singular,perspective,identity.map(()=>Infinity)])assert.throws(()=>materialGraph(surface.paint('moonstone',{domain:domain.transform(matrix)})));
  assert.throws(()=>scalarGraph(scalar.ramp(scalar.axis(),1e9,1e9+1)),/float32/);
  assert.throws(()=>compileGraph(scalarGraph(scalar.multiply(scalar.parameter(1e20),scalar.parameter(1e20)))),/float32/);
  const huge=[1e20,0,0,0,0,1e20,0,0,0,0,1e20,0,0,0,0,1];
  const chain=domain.transform(huge,domain.transform(huge));
  assert.throws(()=>compileGraph(surface.paint('moonstone',{domain:chain})),/Composed domain/);
});

test('constructors snapshot raw author data without freezing or mutating it',()=>{
  const raw={kind:'parameter',value:.3};
  const expr=scalar.add(raw,raw);
  assert.equal(Object.isFrozen(raw),false);
  raw.value=.8;
  assert.equal(sample(expr).value,.6);
  const style={roughness:.4},palette={base:{kind:'color',value:[.1,.2,.3]}};
  const painted=surface.paint(facets(),style,palette);
  assert.equal(Object.isFrozen(style),false);assert.equal(Object.isFrozen(palette),false);
  assert.equal(Object.isFrozen(palette.base.value),false);
  style.roughness=.9;palette.base.value[0]=1;
  const graph=materialGraph(painted),paint=graph.nodes.find(n=>n.kind==='paint');
  assert.equal(paint.style.roughness,.4);
  assert.deepEqual(graph.nodes.find(n=>n.id===paint.palette.base).value,[.1,.2,.3]);
});

test('safe computed float32 magnitudes remain valid across lowering and domain composition',()=>{
  const graph=scalarGraph(scalar.multiply(1e15,1e15)),plan=compileGraph(graph);
  const optimized={version:2,nodes:plan.nodes,output:plan.output};
  assert.equal(sample(scalar.multiply(1e15,1e15)).value,1e30);
  assert.equal(evaluateScalar(optimized,scalarRoot(optimized)).value,1e30);
  assert.throws(()=>compileGraph(scalarGraph(scalar.multiply(1e20,1e20))),/folded product/);
  const tiny=[1e-15,0,0,0,0,1e-15,0,0,0,0,1e-15,0,0,0,0,1];
  const frame=domain.transform(tiny,domain.transform(tiny));
  assert.doesNotThrow(()=>compileGraph(surface.paint('moonstone',{domain:frame})));
});

test('scalar algebra laws agree before and after optimization across deterministic samples',()=>{
  const x=scalar.axis('x'),y=scalar.axis('y');
  const laws=[
    [scalar.add(x,0),x],[scalar.multiply(x,1),x],[scalar.multiply(x,0),scalar.constant(0)],
    [scalar.complement(scalar.complement(x)),x],
    [scalar.add(x,y),scalar.add(y,x)],
    [scalar.multiply(x,scalar.add(y,2)),scalar.add(scalar.multiply(x,y),scalar.multiply(x,2))],
  ];
  for(let i=0;i<41;i++) {
    const context={position:[Math.sin(i*1.7)*4,Math.cos(i*.37)*3,0],dx:[.2,.7,0],dy:[-.1,.3,0]};
    for(const [left,right] of laws) {
      const a=sample(left,context),b=sample(right,context);
      for(const key of ['value','dx','dy'])close(a[key],b[key],1e-10);
      const graph=scalarGraph(left),plan=compileGraph(graph),optimized={version:2,nodes:plan.nodes,output:plan.output};
      const c=evaluateScalar(optimized,scalarRoot(optimized),context);
      for(const key of ['value','dx','dy'])close(a[key],c[key],1e-10);
    }
  }
});

test('analytic scalar first differentials match finite differences through products and ramps',()=>{
  const field=scalar.multiply(scalar.ramp(scalar.axis('x'),-2,2),scalar.add(scalar.axis('y'),.4));
  const graph=scalarGraph(field),id=scalarRoot(graph),position=[.2,.8,-.1],dx=[.3,.2,0],dy=[-.1,.4,.2];
  const actual=evaluateScalar(graph,id,{position,dx,dy}),eps=1e-5;
  for(const [key,delta] of [['dx',dx],['dy',dy]]) {
    const at=sign=>evaluateScalar(graph,id,{position:position.map((v,i)=>v+sign*eps*delta[i])}).value;
    close(actual[key],(at(1)-at(-1))/(2*eps),1e-7);
  }
});

test('affine domain composition obeys matrix order and transforms first differentials',()=>{
  const inner=[2,0,0,0,0,3,0,0,0,0,.5,0,1,2,3,1];
  const outer=[1,0,0,0,.5,1,0,0,0,0,1,0,-2,1,0,1];
  const nested=domain.transform(outer,domain.transform(inner));
  const graph=materialGraph(surface.paint('horn',{domain:nested}));
  const id=graph.nodes.find(n=>n.kind==='facets').domain;
  const result=evaluateDomain(graph,id,{position:[1,2,3],normal:[0,1,0],dx:[1,0,0],dy:[0,1,0]});
  assert.deepEqual(result.position,[5,9,4.5]);
  assert.deepEqual(result.dx,[2,0,0]);assert.deepEqual(result.dy,[1.5,3,0]);
  const positionBefore=evaluateDomain(graph,undefined,{position:[1,2,3]}).position;
  assert.deepEqual(positionBefore,[1,2,3]);
  const normal=evaluateDomain(graph,id,{normal:[1,1,0]}).normal;
  const expected=[.5,1/3-.25,0],length=Math.hypot(...expected);
  expected.forEach((v,i)=>close(normal[i],v/length));
});

test('facing carries normal differentials through inverse-transpose normalization',()=>{
  const frame=domain.transform([2,0,0,0,0,1,0,0,0,0,.5,0,0,0,0,1]);
  const field=scalar.facing([1,1,.2],frame),graph=scalarGraph(field),id=scalarRoot(graph);
  const context={normal:[.4,1,.2],normalDx:[.3,-.1,.05],normalDy:[0,0,0]};
  const actual=evaluateScalar(graph,id,context),eps=1e-5;
  const at=sign=>evaluateScalar(graph,id,{normal:context.normal.map((v,i)=>v+sign*eps*context.normalDx[i])}).value;
  close(actual.dx,(at(1)-at(-1))/(2*eps),1e-7);
});

test('opacity bounds are conservative and update without changing the program',()=>{
  const field=facets();
  const graph=materialGraph(surface.mix(surface.paint(field,{opacity:1}),surface.paint(field,{opacity:.25}),scalar.parameter(0)));
  assert.deepEqual(compileGraph(graph).opacityRange,[1,1]);
  const changed=copy(graph);changed.nodes.find(n=>n.kind==='parameter').value=1;
  assert.deepEqual(compileGraph(changed).opacityRange,[.25,.25]);
  assert.equal(compileGraph(graph).programKey,compileGraph(changed).programKey);
  const varying=materialGraph(surface.mix(surface.paint(field,{opacity:1}),surface.paint(field,{opacity:.25}),scalar.axis('x')));
  assert.deepEqual(compileGraph(varying).opacityRange,[.25,1]);
  const overridden=compileGraph(surface.channels(surface.paint(),{opacity:scalar.add(scalar.parameter(.2),scalar.parameter(.3))}));
  assert.deepEqual(overridden.opacityRange,[.5,.5]);
  const clamped=compileGraph(surface.channels(surface.paint(),{opacity:scalar.axis('x')}));
  assert.deepEqual(clamped.opacityRange,[0,1]);
});
