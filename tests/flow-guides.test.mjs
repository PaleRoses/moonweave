import test from 'node:test';
import assert from 'node:assert/strict';
import {bakeMeshFlow, guidedStrokes, sampleFlow, traceFlow} from '../src/paint/flow-guides.mts';

const angle=(d)=>Math.atan2(d[1],d[0]);
const difference=(a,b)=>Math.acos(Math.min(1,Math.abs(a[0]*b[0]+a[1]*b[1])));
function grid(width=24,height=24,shape=(x,y)=>.22*Math.cos(10*(x+.2*Math.sin(3*y)))){
  const positions=[],uv=[],indices=[];
  for(let j=0;j<=height;j++)for(let i=0;i<=width;i++){
    const u=i/width,v=j/height;
    positions.push(u,v,shape(u,v));uv.push(u,v);
  }
  for(let j=0;j<height;j++)for(let i=0;i<width;i++){
    const a=j*(width+1)+i,b=a+1,c=a+width+1,d=c+1;
    indices.push(a,b,d,a,d,c);
  }
  return {positions,uv,indices};
}
function flatGuide(directions){
  const positions=[],uv=[],indices=[],foldGuides=[],ambientOcclusion=[];
  // three physically separate plates on disjoint thirds of a UV atlas
  for(let k=0;k<3;k++){
    const x0=k/3,dx=1/3,ids=positions.length/3;
    positions.push(x0,0,k,x0+dx,0,k,x0,.99,k,x0+dx,.99,k);
    uv.push(x0,0,x0+dx,0,x0,.99,x0+dx,.99);
    const [x,y]=directions[k];
    for(let j=0;j<4;j++){foldGuides.push(x,y,0);ambientOcclusion.push(k===1?.25:1);}
    indices.push(ids,ids+1,ids+3,ids,ids+3,ids+2);
  }
  return {positions,uv,indices,foldGuides,ambientOcclusion};
}

test('mesh fold curvature produces a spatially varying line field, not a single texture-grid direction',()=>{
  const atlas=bakeMeshFlow(grid(),{width:192,height:192});
  assert.ok(atlas.stats.coveredTexels>35000);
  const samples=[[.24,.2],[.24,.8],[.54,.25],[.54,.75]].map(at=>sampleFlow(atlas,at));
  assert.ok(samples.every(Boolean),'fold field defined over folded cloth');
  const varied=samples.some((a,i)=>samples.some((b,j)=>j>i&&difference(a,b)>.14));
  assert.ok(varied,`cloth directions should vary with fold (got ${samples.map(x=>angle(x).toFixed(2))})`);
  // No AO was supplied: the shade map does NOT derive its value from world Y.
  assert.ok(atlas.shade.data.every(v=>v===1));
});

test('independent bronze plates follow their own authored fold directions and AO, not global diagonal',()=>{
  const atlas=bakeMeshFlow(flatGuide([[1,0],[1,1],[0,1]]),{width:180,height:90});
  const dirs=[1/6,.5,5/6].map(x=>sampleFlow(atlas,[x,.45]));
  assert.ok(dirs.every(Boolean));
  assert.ok(difference(dirs[0],dirs[1])>.5);
  assert.ok(difference(dirs[1],dirs[2])>.5);
  assert.ok(difference(dirs[0],dirs[2])>1.3);
  assert.ok(Math.abs(atlas.shade.data[(Math.floor(.45*90)*180+90)]-.25)<.04);
  const marks=guidedStrokes(atlas,{seeds:[[1/6,.45],[.5,.45],[5/6,.45]],brush:'bristle',color:[.8,.6,.3],radius:.025,length:.24,step:.006});
  assert.equal(marks.length,3);
  assert.ok(marks[1].color[0]<marks[0].color[0], 'AO modulates pigment brightness on shaded plate');
  assert.ok(marks.every(mark=>mark.kind==='stroke'&&mark.points.length>5));
});

test('tracing bends as the local field turns and never teleports across UV gaps',()=>{
  const width=128,height=128,data=[];
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const u=(x+.5)/width,v=(y+.5)/height,theta=.1+1.35*u;
    const valid=(u<.45||u>.55) ? 1 : 0;
    data.push(Math.cos(2*theta)*valid,Math.sin(2*theta)*valid,valid);
  }
  const atlas={direction:{width,height,channels:3,data},shade:{width,height,channels:1,data:new Array(width*height).fill(1)}};
  const curved=traceFlow(atlas,{seed:[.18,.25],length:.45,step:.005,taper:.2});
  assert.ok(curved.length>10);
  const start=curved[0].at,end=curved[curved.length-1].at,mid=curved[Math.floor(curved.length/2)].at;
  const chord=[end[0]-start[0],end[1]-start[1]];
  const deviation=Math.abs((mid[0]-start[0])*chord[1]-(mid[1]-start[1])*chord[0])/Math.hypot(...chord);
  assert.ok(deviation>.006,`streamline should curve, deviation=${deviation}`);
  assert.ok(curved.every(p=>p.at[0]<.45),'line should stop at the gap instead of bridging UV islands');
  assert.ok(Math.abs(curved[0].pressure-.2)<.001&&Math.abs(curved.at(-1).pressure-.2)<.001);
});

test('opposite guide arrows produce the same interpolated line orientation',()=>{
  const a=flatGuide([[1,0],[0,1],[1,1]]),b=flatGuide([[1,0],[0,1],[1,1]]);
  for(let i=0;i<b.foldGuides.length;i++)if(i%6<3)b.foldGuides[i]*=-1;
  const A=bakeMeshFlow(a,{width:180,height:90}),B=bakeMeshFlow(b,{width:180,height:90});
  for(const uv of [[.15,.45],[.5,.45],[.85,.45]]){
    assert.ok(difference(sampleFlow(A,uv),sampleFlow(B,uv))<1e-5);
  }
});

test('flat ambiguous curvature gets no fabricated direction; explicit guides resolve it',()=>{
  const mesh=grid(6,6,()=>0);
  const ambiguous=bakeMeshFlow(mesh,{width:48,height:48});
  assert.equal(sampleFlow(ambiguous,[.4,.5]),null);
  mesh.foldGuides=Array.from({length:mesh.positions.length/3},()=>[0,1,0]).flat();
  const guided=bakeMeshFlow(mesh,{width:48,height:48});
  assert.ok(sampleFlow(guided,[.4,.5]));
});

test('rejects contradictory overlapping UV interiors and malformed/budget-breaking inputs',()=>{
  const mesh=flatGuide([[1,0],[1,1],[0,1]]);
  assert.throws(()=>bakeMeshFlow(mesh,{width:1000,height:1000}),/budget/);
  assert.throws(()=>bakeMeshFlow({...mesh,indices:[0,99,2]},{width:64,height:64}),/index/);
  assert.throws(()=>bakeMeshFlow({...mesh,ambientOcclusion:new Array(12).fill(-.2)},{width:64,height:64}),/AO/);
  const over={positions:[0,0,0,1,0,0,0,1,0, 0,0,1,1,0,1,0,1,1],uv:[0,0,1,0,0,1, 0,0,1,0,0,1],foldGuides:[1,0,0,1,0,0,1,0,0, 0,1,0,0,1,0,0,1,0]};
  assert.throws(()=>bakeMeshFlow(over,{width:48,height:48}),/Overlapping UV/);
});