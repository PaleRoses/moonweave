import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import * as THREE from 'three-legacy';
import {createPaintTextures} from '../src/three/textures.mts';

const topData=new Uint8Array(512*512*4),wallData=new Uint8Array(512*512*4);
const custom={topData,wallData};
const sha=data=>createHash('sha256').update(data).digest('hex');

test('texture pair is lazy, stable, mipfiltered and explicitly scalar data',()=>{
  const fields=createPaintTextures(THREE,{...custom,anisotropy:4});
  assert.equal(fields.top,null);assert.equal(fields.wall,null);assert.equal(fields.bytes,0);
  assert.equal(fields.stats.builds.length,0);
  const pair=fields.ensure();assert(Object.isFrozen(pair));assert.equal(fields.ensure(),pair);
  assert.equal(fields.top,pair.top);assert.equal(fields.wall,pair.wall);
  assert.equal(fields.bytes,2796200);assert.equal(fields.resolution,512);assert.equal(fields.seed,29031);
  for(const [texture,data] of [[pair.top,topData],[pair.wall,wallData]]){
    assert.equal(texture.image.data,data);assert.equal(texture.encoding,THREE.LinearEncoding);
    assert.equal(texture.wrapS,THREE.RepeatWrapping);assert.equal(texture.wrapT,THREE.RepeatWrapping);
    assert.equal(texture.minFilter,THREE.LinearMipmapLinearFilter);assert.equal(texture.magFilter,THREE.LinearFilter);
    assert.equal(texture.anisotropy,4);assert.equal(texture.generateMipmaps,true);assert.equal(texture.unpackAlignment,1);
  }
  assert.equal(fields.stats.builds.length,1);assert.equal(fields.stats.builds[0].field,'paintPair');
  assert(Object.isFrozen(fields.stats)&&Object.isFrozen(fields.stats.builds));
  assert.match(fields.stats.metric,/excludes GPU/);fields.dispose();
});

test('default textures retain the independently recorded revision-42 atlas bytes',()=>{
  const fields=createPaintTextures(THREE),pair=fields.ensure();
  assert.equal(fields.layout,'filled-facets/11');
  assert.equal(sha(pair.top.image.data),'3a38f0003bb1f6f7d9e3544984c743660620e152eb60d9cf6c1bee415ef74bee');
  assert.equal(sha(pair.wall.image.data),'2efad1139805ed156611cfb0c44b06e9d9c28091457a4eacb39358800ad8ea99');
  fields.dispose();
});

test('options are captured and independent seeded owners do not share GPU lifetimes',()=>{
  const options={seed:73},a=createPaintTextures(THREE,options),b=createPaintTextures(THREE,{seed:73});
  options.seed=19;
  const A=a.ensure(),B=b.ensure();
  assert.equal(a.seed,73);assert.notEqual(A.top,B.top);assert.notEqual(A.wall,B.wall);
  assert.equal(sha(A.top.image.data),sha(B.top.image.data));
  assert.notEqual(sha(A.top.image.data),'3a38f0003bb1f6f7d9e3544984c743660620e152eb60d9cf6c1bee415ef74bee');
  a.dispose();assert(!b.disposed);assert.equal(b.ensure(),B);b.dispose();
});

test('both supplied maps validate before any texture allocation',()=>{
  let allocations=0;
  class CountedTexture extends THREE.DataTexture{constructor(...args){super(...args);allocations++;}}
  const host={...THREE,DataTexture:CountedTexture};
  for(const input of [{topData},{wallData},{topData,wallData:new Uint8Array(4)},{topData:new Uint8ClampedArray(topData.length),wallData}]){
    const fields=createPaintTextures(host,input);
    assert.throws(()=>fields.ensure(),/both matching/);
    assert.equal(allocations,0);assert.equal(fields.top,null);assert.equal(fields.wall,null);assert.equal(fields.bytes,0);
    assert.equal(fields.stats.builds.length,0);fields.dispose();
  }
});

test('a second texture failure rolls back the first and permits a clean retry',()=>{
  let allocations=0,disposals=0;
  class FailingTexture extends THREE.DataTexture{
    constructor(...args){super(...args);if(++allocations===2)throw new Error('allocation failure');this.addEventListener('dispose',()=>disposals++);}
  }
  const fields=createPaintTextures({...THREE,DataTexture:FailingTexture},custom);
  assert.throws(()=>fields.ensure(),/allocation failure/);
  assert.equal(disposals,1);assert.equal(fields.top,null);assert.equal(fields.wall,null);assert.equal(fields.bytes,0);assert.equal(fields.stats.builds.length,0);
  const accepted=fields.ensure();assert.equal(fields.ensure(),accepted);assert.equal(fields.stats.builds.length,1);
  fields.dispose();assert.equal(disposals,3);
});

test('modern Three data textures use NoColorSpace without legacy encoding writes',()=>{
  class ModernTexture extends THREE.DataTexture{
    constructor(...args){
      super(...args);this.colorSpace='srgb';
      Object.defineProperty(this,'encoding',{set(){throw new Error('legacy encoding write');}});
    }
  }
  const fields=createPaintTextures({...THREE,DataTexture:ModernTexture,NoColorSpace:''},custom);
  const pair=fields.ensure();assert.equal(pair.top.colorSpace,'');assert.equal(pair.wall.colorSpace,'');fields.dispose();
});

test('only owner disposal releases the two textures, exactly once',()=>{
  const fields=createPaintTextures(THREE,custom),pair=fields.ensure();let disposed=0;
  for(const texture of [pair.top,pair.wall])texture.addEventListener('dispose',()=>disposed++);
  fields.ensure();fields.ensure();assert.equal(disposed,0);
  fields.dispose();fields.dispose();assert.equal(disposed,2);assert(fields.disposed);assert(fields.stats.disposed);
  assert.equal(fields.top,null);assert.equal(fields.wall,null);assert.equal(fields.bytes,0);
  assert.equal(fields.stats.builds.length,1,'construction evidence survives resource release');
  assert.throws(()=>fields.ensure(),/disposed/);
  const empty=createPaintTextures(THREE);empty.dispose();assert.equal(empty.bytes,0);assert.throws(()=>empty.ensure(),/disposed/);
});

test('one failing disposal listener cannot prevent cleanup of the second texture',()=>{
  const fields=createPaintTextures(THREE,custom),pair=fields.ensure();let wallDisposals=0;
  pair.top.addEventListener('dispose',()=>{throw new Error('top listener failed');});
  pair.wall.addEventListener('dispose',()=>wallDisposals++);
  assert.throws(()=>fields.dispose(),error=>error instanceof AggregateError&&error.errors.length===1);
  assert.equal(wallDisposals,1);assert(fields.disposed);
  assert.equal(fields.top,null);assert.equal(fields.wall,null);assert.equal(fields.bytes,0);
  assert.doesNotThrow(()=>fields.dispose());assert.equal(wallDisposals,1);
});

test('invalid configuration fails before field generation',()=>{
  for(const options of [null,[],{resolution:256},{resolution:NaN},{seed:-1},{seed:1.5},{seed:4294967296},{anisotropy:0},{anisotropy:17},{anisotropy:NaN},{typo:true}]){
    assert.throws(()=>createPaintTextures(THREE,options));
  }
  assert.throws(()=>createPaintTextures({},custom),/Three/);
});

test('surface-only texture owner has no engine, terrain, road or editor dependencies',()=>{
  const visited=new Set();
  function visit(url){
    if(visited.has(url.href))return;visited.add(url.href);
    const raw=readFileSync(url,'utf8');
    const source=url.pathname.endsWith('.mts') ? stripTypeScriptTypes(raw) : raw;
    for(const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert(match[1].startsWith('.'), `Unexpected external field dependency: ${match[1]}`);
      visit(new URL(match[1],url));
    }
  }
  visit(new URL('../src/three/textures.mts',import.meta.url));
  for(const name of visited)assert.doesNotMatch(name,/terrain|road|place|studio|adapter|shader|schema/);
});
