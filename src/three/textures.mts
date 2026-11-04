import type {DataTexture} from 'three';
import type {PaintTextureEngine} from './engine.mts';

export interface PaintTextureOptions {
  readonly resolution?: 512 | 1024;
  readonly seed?: number;
  readonly anisotropy?: number;
  readonly topData?: Uint8Array;
  readonly wallData?: Uint8Array;
}
export interface TexturePair {readonly top: DataTexture; readonly wall: DataTexture}
export interface TextureBuild {readonly field: string; readonly cpuMs: number; readonly textureBytes: number}
export type PaintTextures = ReturnType<typeof createPaintTextures>;

import {drawingFieldBytes,makePaintFields,PAINT_LAYOUT,PAINT_SIZE} from '../paint/data.mts';

function releaseTextures(textures: Iterable<DataTexture | null | undefined>): unknown[]{
  const failures=[];
  for(const texture of textures)if(texture){try{texture.dispose();}catch(error){failures.push(error);}}
  return failures;
}

/** Scalar fields contain pigment weights and authored slopes, not display RGB.
 * Keep their channels linear on both older and current Three releases. */
function createPeriodicDataTexture(THREE: PaintTextureEngine,data: Uint8Array,resolution: number,anisotropy: number,name: string){
  const texture=new THREE.DataTexture(data,resolution,resolution,THREE.RGBAFormat,THREE.UnsignedByteType);
  try{
    texture.name='Moonweave / '+name;
    texture.wrapS=texture.wrapT=THREE.RepeatWrapping;
    texture.magFilter=THREE.LinearFilter;
    texture.minFilter=THREE.LinearMipmapLinearFilter;
    texture.anisotropy=anisotropy;
    texture.generateMipmaps=true;
    texture.unpackAlignment=1;
    if('colorSpace' in texture)texture.colorSpace=THREE.NoColorSpace??'';
    else if(THREE.LinearEncoding!==undefined)(texture as DataTexture & {encoding: number}).encoding=THREE.LinearEncoding;
    texture.needsUpdate=true;
    return texture;
  }catch(error){
    const failures=releaseTextures([texture]);
    if(failures.length)throw new AggregateError([error,...failures],'Texture setup and cleanup failed.');
    throw error;
  }
}

/** Lazy owner for Moonweave's original paired drawing fields. A material borrows
 * this owner; only its creator disposes it, after all borrowing materials.
 * Custom bytes are borrowed without copying, and must remain immutable.
 * No terrain, architecture, renderer instance or global resource cache. */
function createPaintTextures(THREE: PaintTextureEngine,options: PaintTextureOptions={}){
  if(!THREE?.DataTexture)throw new TypeError('Supply the host Three namespace.');
  if(!options||typeof options!=='object'||Array.isArray(options)||![Object.prototype,null].includes(Object.getPrototypeOf(options)))throw new TypeError('Paint texture options must be a plain object.');
  for(const key of Object.keys(options))if(!['resolution','seed','anisotropy','topData','wallData'].includes(key))throw new RangeError('Unknown paint texture option: '+key);
  const {resolution=PAINT_SIZE,seed=29031,anisotropy=1}=options;
  const allocationBytes=drawingFieldBytes(resolution);
  if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new RangeError('Drawing seed must be uint32.');
  if(!Number.isFinite(anisotropy)||anisotropy<1||anisotropy>16)throw new RangeError('Field anisotropy must be in [1,16].');
  let supplied=options.topData!==undefined||options.wallData!==undefined?{top:options.topData,wall:options.wallData}:null;
  let pair: TexturePair | null=null;
  let disposed=false;
  const builds: TextureBuild[]=[];
  function ensure(): TexturePair{
    if(disposed)throw new Error('Paint textures have been disposed.');
    if(pair)return pair;
    const start=performance.now();
    const fields=supplied??makePaintFields({size:resolution,seed});
    for(const data of [fields.top,fields.wall]){
      if(!(data instanceof Uint8Array)||data.length!==resolution*resolution*4)throw new TypeError('Supply both matching '+resolution+'² filled-facet RGBA8 maps.');
    }
    let top: DataTexture | null=null,wall: DataTexture | null=null;
    try{
      top=createPeriodicDataTexture(THREE,fields.top!,resolution,anisotropy,'upper facets');
      wall=createPeriodicDataTexture(THREE,fields.wall!,resolution,anisotropy,'lateral facets');
    }catch(error){
      const failures=releaseTextures([top,wall]);
      if(failures.length)throw new AggregateError([error,...failures],'Paint texture setup and cleanup failed.');
      throw error;
    }
    pair=Object.freeze({top,wall});
    supplied=null;
    builds.push(Object.freeze({field:'paintPair',cpuMs:performance.now()-start,textureBytes:allocationBytes}));
    return pair;
  }
  return Object.freeze({
    resolution,seed,layout:PAINT_LAYOUT,ensure,
    get top(){return pair?.top??null;},
    get wall(){return pair?.wall??null;},
    get bytes(){return pair?allocationBytes:0;},
    get disposed(){return disposed;},
    get stats(){return Object.freeze({metric:'CPU construction and texture-object setup; excludes GPU upload/rendering',builds:Object.freeze([...builds]),totalCpuMs:builds.reduce((sum,build)=>sum+build.cpuMs,0),disposed});},
    dispose(){
      if(disposed)return;disposed=true;
      const textures=pair;
      pair=null;supplied=null;
      const failures=releaseTextures([textures?.top,textures?.wall]);
      if(failures.length)throw new AggregateError(failures,'Paint texture cleanup completed with resource errors.');
    },
  });
}

export {createPaintTextures,createPeriodicDataTexture};
