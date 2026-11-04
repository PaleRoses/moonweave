export interface PaintFieldOptions {readonly size?: 512 | 1024; readonly seed?: number}
import {drawingHash} from './random.mjs';
import {makeDrawingStructures} from './structure.mjs';
const mix=(a: number,b: number,t: number)=>a+(b-a)*t;
/** Paired periodic RGBA8 drawing fields. R is pigment / low-frequency wash,
 * G is a filled facet value, BA encode AUTHORED plane slopes, not a derivative
 * of an 8-bit height image. Top and walls have independent shapes and normals.
 * Neither image contains a perimeter SDF. All mips average continuous data.
 * This intentionally replaces the 09/10 custom drawing-data ABI. */
const PAINT_SIZE=512,PAINT_CELLS=24;
const PAINT_TEXTURE_BYTES=4*(PAINT_SIZE*PAINT_SIZE*4-1)/3;
const PAINT_BYTES=PAINT_TEXTURE_BYTES*2;
const PAINT_CHANNELS=Object.freeze({r:'periodic pigment wash',g:'filled painted facet value',b:'signed authored U slope',a:'signed authored V slope'});
const PAINT_LAYOUT='filled-facets/11';
/** A small separable lattice plan. Hash each lattice corner once and retain
 * horizontal interpolation rows, not a full-resolution image per octave.
 * The operation order and float64 samples match periodicNoise exactly. */
function periodicRows(size: number,n: number,seed: number,ny=n){
  const lattice=new Float64Array(n*ny),horizontal=new Float64Array(size*ny),row=new Float64Array(size);
  for(let y=0;y<ny;y++)for(let x=0;x<n;x++)lattice[y*n+x]=drawingHash(x,y,seed);
  for(let y=0;y<ny;y++)for(let x=0;x<size;x++){
    const q=(x+.5)/size*n,ix=Math.floor(q),u=q-ix,a=u*u*(3-2*u);
    horizontal[y*size+x]=mix(lattice[y*n+ix%n],lattice[y*n+(ix+1)%n],a);
  }
  return (y: number)=>{
    const q=(y+.5)/size*ny,iy=Math.floor(q),v=q-iy,b=v*v*(3-2*v),lo=(iy%ny)*size,hi=((iy+1)%ny)*size;
    for(let x=0;x<size;x++)row[x]=mix(horizontal[lo+x],horizontal[hi+x],b);
    return row;
  };
}
function makePaintFields({size=PAINT_SIZE,seed=29031}: PaintFieldOptions={}){
  if(![512,1024].includes(size))throw new RangeError('Drawing resolution must be 512 or 1024.');
  if(!Number.isInteger(seed)||seed<0||seed>4294967295)throw new RangeError('Drawing seed must be uint32.');
  const topData=new Uint8Array(size*size*4),wallData=new Uint8Array(size*size*4);
  const {top,wall,scumble,topGrad,wallGrad}=makeDrawingStructures(size,seed);
  const slope=(v: number)=>Math.round(128+Math.max(-1,Math.min(1,v))*127);
  const broad=periodicRows(size,4,seed+1),middle=periodicRows(size,9,seed+2),fine=periodicRows(size,19,seed+3),streak=periodicRows(size,11,seed+81,3);
  for(let y=0;y<size;y++){
    const a=broad(y),b=middle(y),c=fine(y),d=streak(y);
    for(let x=0;x<size;x++){
      const k=y*size+x,o=k*4,wash=.57*a[x]+.29*b[x]+.14*c[x];
      topData[o]=Math.round(wash*255);topData[o+1]=Math.round(top[k]*255);
      topData[o+2]=slope(topGrad.x[k]);topData[o+3]=slope(topGrad.y[k]);
      const stain=.7*d[x]+.3*scumble[k];
      wallData[o]=Math.round(stain*255);wallData[o+1]=Math.round(wall[k]*255);
      wallData[o+2]=slope(wallGrad.x[k]);wallData[o+3]=slope(wallGrad.y[k]);
    }
  }
  return {top:topData,wall:wallData,size,layout:PAINT_LAYOUT};
}
// Convenience for callers preparing one map. Resource owners use the paired
// function once, so both maps share construction work without a global cache.
function drawingFieldBytes(size: 512 | 1024=PAINT_SIZE){if(![512,1024].includes(size))throw new RangeError('Drawing resolution must be 512 or 1024.');return 8*(size*size*4-1)/3;}
function makePaintData(options: PaintFieldOptions={}){return makePaintFields(options).top;}

export {drawingFieldBytes,PAINT_SIZE,PAINT_CELLS,PAINT_BYTES,PAINT_TEXTURE_BYTES,PAINT_CHANNELS,PAINT_LAYOUT,makePaintData,makePaintFields};
