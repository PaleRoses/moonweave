/** Texture-space construction primitives. No renderer, world mesh or shared RNG.
 * Counter-clockwise hulls give deterministic half-plane coverage, including
 * shapes crossing the toroidal texture boundary. Coordinates are reference
 * texels: increasing raster resolution never changes the authored structure. */
const mod=(x,n)=>(x%n+n)%n;
function convexHull(points){
  const sorted=points.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const cross=(a,b,c)=>(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const chain=ps=>{const out=[];for(const p of ps){while(out.length>1&&cross(out.at(-2),out.at(-1),p)<=0)out.pop();out.push(p);}return out;};
  const low=chain(sorted),high=chain(sorted.slice().reverse());low.pop();high.pop();return low.concat(high);
}
function shardPolygon(x,y,width,height,angle,random,id,wall=false){
  // Chisel-cut, skewed polygons. Not a regular polar ring: the previous ring
  // plus a perimeter bevel made every overlapping mark read as a pebble.
  const profiles=wall?[
    [-.45,-.51],[.18,-.58],[.49,-.27],[.27,.54],[-.12,.48],[-.5,.17],
  ]:[[-.55,-.21],[-.23,-.48],[.36,-.38],[.53,.09],[.14,.47],[-.42,.32]];
  const cs=Math.cos(angle),sn=Math.sin(angle);
  return convexHull(profiles.map(([u,v],j)=>{
    u+=(random(id,41+j*2)-.5)*.23;v+=(random(id,42+j*2)-.5)*.20;
    u*=width;v*=height;
    return [x+u*cs-v*sn,y+u*sn+v*cs];
  }));
}
function rasterShard(out,size,points,{tone=.5,tilt=[0,0],crease=0,creaseAngle=0,origin=[0,0],extent=1,gradients=null,cutFace=false,wall=false}={}){
  const scale=size/512,n=points.length;
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const ex=new Float64Array(n),ey=new Float64Array(n),nx=new Float64Array(n),ny=new Float64Array(n);
  for(let i=0;i<n;i++){
    const a=points[i],b=points[(i+1)%n],dx=b[0]-a[0],dy=b[1]-a[1],length=Math.hypot(dx,dy);
    ex[i]=a[0];ey[i]=a[1];nx[i]=-dy/length;ny[i]=dx/length;
    minX=Math.min(minX,a[0]);maxX=Math.max(maxX,a[0]);minY=Math.min(minY,a[1]);maxY=Math.max(maxY,a[1]);
  }
  const cx=Math.cos(creaseAngle),cy=Math.sin(creaseAngle),aa=.48/scale;
  let cut=-1,best=-Infinity;
  if(cutFace)for(let i=0;i<n;i++){const score=wall?nx[i]:ny[i];if(score>best){best=score;cut=i;}}
  const cutWidth=Math.max(.65,extent*.045),cutAA=Math.max(aa,.2);
  const x0=Math.floor(minX*scale)-1,x1=Math.ceil(maxX*scale)+1,width=x1-x0+1;
  const uTilt=new Float64Array(width),uCrease=new Float64Array(width);
  const columns=new Uint32Array(width),terms=new Float64Array(width*n),rows=new Float64Array(n);
  // Preserve each multiplication and addition from the original evaluator, but
  // evaluate column/row invariants once. Double precision is deliberate: packing
  // the edge terms into float32 would change overlap and pigment bytes.
  for(let j=0;j<width;j++){
    const x=(x0+j+.5)/scale,u=(x-origin[0])/extent;columns[j]=mod(x0+j,size);
    uTilt[j]=u*tilt[0];uCrease[j]=u*cx;
    for(let e=0;e<n;e++)terms[j*n+e]=(x-ex[e])*nx[e];
  }
  const slopes=[0,crease].map(s=>[
    Math.max(-.95,Math.min(.95,(tilt[0]+s*cx)*3.4)),
    Math.max(-.95,Math.min(.95,(tilt[1]+s*cy)*3.4)),
  ]);
  for(let iy=Math.floor(minY*scale)-1;iy<=Math.ceil(maxY*scale)+1;iy++){
    const y=(iy+.5)/scale,v=(y-origin[1])/extent,vTilt=v*tilt[1],vCrease=v*cy,row=mod(iy,size)*size;
    let lo=-Infinity,hi=Infinity;
    for(let e=0;e<n;e++){
      rows[e]=(y-ey[e])*ny[e];const rhs=-aa-rows[e];
      if(nx[e]>1e-14)lo=Math.max(lo,ex[e]+rhs/nx[e]);
      else if(nx[e]<-1e-14)hi=Math.min(hi,ex[e]+rhs/nx[e]);
      // Almost horizontal edges are left to the exact reduction below.
    }
    // Conservative one-texel guards; culling never substitutes for coverage.
    const first=Math.max(0,Math.ceil(lo*scale-.5-x0)-1),last=Math.min(width-1,Math.floor(hi*scale-.5-x0)+1);
    for(let j=first;j<=last;j++){
      let d=Infinity;const at=j*n;
      for(let e=0;e<n;e++)d=Math.min(d,terms[at+e]+rows[e]);
      if(d<-aa)continue;
      const hinge=uCrease[j]+vCrease,face=tone+uTilt[j]+vTilt+Math.max(0,hinge)*crease;
      const cutDistance=cut<0?Infinity:terms[at+cut]+rows[cut];
      const cutCoverage=cut<0?0:Math.max(0,Math.min(1,(cutWidth-cutDistance)/cutAA+.5));
      const value=Math.max(.08,Math.min(.92,face-cutCoverage*.17)),coverage=Math.max(0,Math.min(1,.5+d/(2*aa)));
      const k=row+columns[j];out[k]+=(value-out[k])*coverage;
      if(gradients){
        const slope=slopes[hinge>0?1:0];let gx=slope[0],gy=slope[1];
        if(cutCoverage>0){gx+=(nx[cut]*.8-gx)*cutCoverage;gy+=(ny[cut]*.8-gy)*cutCoverage;}
        gradients.x[k]+=(gx-gradients.x[k])*coverage;gradients.y[k]+=(gy-gradients.y[k])*coverage;
      }
    }
  }
}

export {convexHull,shardPolygon,rasterShard};
