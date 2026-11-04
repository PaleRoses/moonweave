import {drawingHash} from './random.mjs';
import {shardPolygon,rasterShard} from './shapes.mjs';
/** Filled painted forms, not an outline atlas. Three footprint scales form one
 * overlapping outcrop. Wall shards have their own layout and proportions.
 * No image inputs, per-triangle seeds, bevel collars, or repeated brush glyphs. */
function makeDrawingStructures(size,seed){
  const top=new Float32Array(size*size).fill(.39),wall=new Float32Array(size*size).fill(.35),scumble=new Float32Array(size*size).fill(.5);
  const topGrad={x:new Float32Array(size*size),y:new Float32Array(size*size)},wallGrad={x:new Float32Array(size*size),y:new Float32Array(size*size)};
  const random=(i,j)=>drawingHash(i,j,seed);
  function layer(out,first,count,minWidth,widthRange,aspect,wallMode){
    for(let i=0;i<count;i++){
      const id=first+i,x=random(id,1)*512,y=random(id,2)*512;
      const w=minWidth+random(id,3)*widthRange,h=w*(aspect[0]+random(id,4)*aspect[1]);
      const angle=wallMode?(random(id,5)-.5)*.3:(random(id,5)-.5)*1.2-.22;
      const tone=.23+random(id,6)*.56;
      rasterShard(out,size,shardPolygon(x,y,w,h,angle,random,id,wallMode),{
        tone,tilt:[(random(id,7)-.5)*.21,(random(id,8)-.5)*.12],
        crease:(random(id,9)-.5)*.28,creaseAngle:angle+.4+random(id,10),origin:[x,y],extent:w,cutFace:out!==scumble&&random(id,67)>.15,wall:wallMode,gradients:out===top?topGrad:out===wall?wallGrad:null,
      });
    }
  }
  layer(top,0,145,54,66,[.45,.48],false);
  layer(top,1000,560,16,31,[.35,.53],false);
  layer(top,2000,440,6,12,[.32,.52],false);
  layer(wall,3701,155,21,39,[2.6,2.4],true);
  layer(wall,4701,430,7,17,[1.6,2.3],true);
  // Pigment is patchy filled matter, not rows of tiny blades or chevrons.
  layer(scumble,9001,610,5,13,[.45,.75],false);
  return {top,wall,scumble,topGrad,wallGrad};
}

export {makeDrawingStructures};
