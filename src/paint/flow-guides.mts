/**
 * Authoring-time mesh-guided paint. No Three dependency, mutable scene state,
 * callback in the saved material, or GPU-specific texture format.
 *
 * A stroke direction is a LINE, not an arrow: (dx,dy) and (-dx,-dy) are
 * equivalent. Store (cos(2θ),sin(2θ),confidence) to interpolate without flips.
 * Maps are raw numeric image inputs; Moonweave's image boundary owns their copy.
 */
export type FlowPoint = readonly [number, number];
export interface FlowImage {readonly width: number; readonly height: number; readonly channels: 1 | 3; readonly data: readonly number[]}
export interface FlowMesh {
  readonly positions: ArrayLike<number>; // xyz, indexed or triangle soup
  readonly uv: ArrayLike<number>;        // uv per vertex, row-major
  readonly indices?: ArrayLike<number>;  // triples, optional
  readonly normals?: ArrayLike<number>;  // xyz per vertex, optional
  readonly foldGuides?: ArrayLike<number>; // optional unoriented XYZ per vertex
  readonly ambientOcclusion?: ArrayLike<number>; // light visibility [0,1] per vertex
}
export interface MeshFlowOptions {
  readonly width: number;
  readonly height: number;
  /** Min-|curvature| follows a fold's ridge; max crosses folds. */
  readonly direction?: 'along-fold' | 'across-fold';
  readonly overlap?: 'error' | 'first';
}
export interface FlowAtlas {
  readonly direction: FlowImage; // weighted cos2θ, weighted sin2θ, confidence
  readonly shade: FlowImage;     // AO when supplied, 1 otherwise (not object height)
  readonly stats: Readonly<{triangles: number; coveredTexels: number; degenerateTriangles: number}>;
}
export interface FlowTraceOptions {
  readonly seed: FlowPoint;
  readonly length: number; // total UV arc length
  readonly step: number;   // UV integration step
  readonly minConfidence?: number;
  readonly maxTurnDegrees?: number;
  readonly taper?: number; // pressure at both ends; center stays 1
}
export interface FlowTracePoint {readonly at: FlowPoint; readonly pressure: number}
export interface GuidedStrokeOptions extends Omit<FlowTraceOptions, 'seed'> {
  readonly seeds: readonly FlowPoint[];
  readonly brush: string;
  readonly color: readonly [number, number, number]; // linear Rec709 reflectance
  readonly radius: number;
  readonly opacity?: number;
  readonly aspect?: number;
  readonly spacing?: number;
  readonly shadowStrength?: number; // AO modulation, 0 disables it
  readonly zone?: string;
}

const LIMIT = 262144, EPS = 1e-10;
const unit = (x: number, y: number): FlowPoint | null => {
  const n = Math.hypot(x, y);
  return n > EPS && Number.isFinite(n) ? [x / n, y / n] : null;
};
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: readonly number[], b: readonly number[]): [number, number, number] => [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
const cross = (a: readonly number[], b: readonly number[]): [number, number, number] => [
  a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0],
];
const normalize3 = (v: readonly number[]) => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > EPS ? [v[0]/n, v[1]/n, v[2]/n] as const : [0, 0, 0] as const;
};
const triple = (a: ArrayLike<number>, i: number) => [a[3*i], a[3*i+1], a[3*i+2]] as const;
const pair = (a: ArrayLike<number>, i: number) => [a[2*i], a[2*i+1]] as const;
const finiteArray = (v: ArrayLike<number>, size: number, name: string): void => {
  if (!v || v.length !== size) throw new RangeError(`${name} must contain ${size} components`);
  for (let i=0;i<size;i++) if (!Number.isFinite(v[i])) throw new RangeError(`${name}[${i}] must be finite`);
};
const imageSize = (w: number, h: number, components: number) => {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w > 4096 || h > 4096 || w*h*components > LIMIT)
    throw new RangeError('Flow image exceeds the Moonweave numeric image budget');
};

function vertexNormals(mesh: FlowMesh, faces: readonly (readonly [number,number,number])[], count: number): Float64Array {
  if (mesh.normals) {
    finiteArray(mesh.normals, count*3, 'normals');
    const result=Float64Array.from(mesh.normals);
    for(let i=0;i<count;i++){const v=normalize3(triple(result,i));for(let k=0;k<3;k++)result[3*i+k]=v[k];}
    return result;
  }
  const n = new Float64Array(count*3);
  for (const [a,b,c] of faces) {
    const v = cross(sub(triple(mesh.positions,b),triple(mesh.positions,a)),sub(triple(mesh.positions,c),triple(mesh.positions,a)));
    for (const i of [a,b,c]) for (let k=0;k<3;k++) n[3*i+k]+=v[k];
  }
  for(let i=0;i<count;i++){const v=normalize3(triple(n,i));for(let k=0;k<3;k++)n[3*i+k]=v[k];}
  return n;
}

/** A face's UV-to-tangent Jacobian, plus tangent normal derivatives. */
function faceFrame(mesh: FlowMesh, normals: Float64Array, ids: readonly [number,number,number]) {
  const [a,b,c] = ids, p0=triple(mesh.positions,a), p1=triple(mesh.positions,b), p2=triple(mesh.positions,c);
  const u0=pair(mesh.uv,a), u1=pair(mesh.uv,b), u2=pair(mesh.uv,c);
  const du1=u1[0]-u0[0], dv1=u1[1]-u0[1], du2=u2[0]-u0[0], dv2=u2[1]-u0[1];
  const det=du1*dv2-du2*dv1;
  if (Math.abs(det)<EPS) return null;
  const e1=sub(p1,p0),e2=sub(p2,p0);
  const Pu=[(e1[0]*dv2-e2[0]*dv1)/det,(e1[1]*dv2-e2[1]*dv1)/det,(e1[2]*dv2-e2[2]*dv1)/det];
  const Pv=[(e2[0]*du1-e1[0]*du2)/det,(e2[1]*du1-e1[1]*du2)/det,(e2[2]*du1-e1[2]*du2)/det];
  const a11=Math.hypot(...Pu), t1=normalize3(Pu);
  const a12=dot(Pv,t1), orth=Pv.map((x,k)=>x-a12*t1[k]), a22=Math.hypot(...orth), t2=normalize3(orth);
  if (a11<EPS || a22<EPS) return null;
  const xyzToUV=(v:readonly number[]):FlowPoint|null=> {
    const x=dot(v,t1),y=dot(v,t2),vv=y/a22, uu=(x-a12*vv)/a11;
    return unit(uu,vv);
  };
  const n1=sub(triple(normals,b),triple(normals,a)),n2=sub(triple(normals,c),triple(normals,a));
  const Nu=n1.map((x,k)=>(x*dv2-n2[k]*dv1)/det),Nv=n1.map((x,k)=>(n2[k]*du1-x*du2)/det);
  const d1=Nu.map(x=>x/a11), d2=Nv.map((x,k)=>(x-a12*d1[k])/a22);
  // Symmetrize the estimated shape operator (discrete normal derivatives are noisy).
  const k11=-dot(t1,d1),k12=-(dot(t2,d1)+dot(t1,d2))/2,k22=-dot(t2,d2);
  const tangentToUV = (x:number,y:number):FlowPoint|null => {
    const vv=y/a22,uu=(x-a12*vv)/a11;
    return unit(uu,vv);
  };
  return {uv:[u0,u1,u2] as const, xyzToUV, tangentToUV, eigen:[k11,k12,k22] as const, det};
}

/**
 * Bake a seam-respecting UV line field from triangle curvature or explicit
 * per-vertex 3D fold directions. A flat/umbilic face has zero confidence: no
 * arbitrary global stripe direction is invented. AO is a separate scalar map.
 */
export function bakeMeshFlow(mesh: FlowMesh, options: MeshFlowOptions): FlowAtlas {
  const {width,height}=options;
  imageSize(width,height,4);
  if (!mesh || !mesh.positions || !mesh.uv) throw new TypeError('positions and uv are required');
  if (mesh.positions.length%3) throw new RangeError('positions must contain XYZ triples');
  const n=mesh.positions.length/3;
  finiteArray(mesh.positions,n*3,'positions'); finiteArray(mesh.uv,n*2,'uv');
  if (mesh.foldGuides) finiteArray(mesh.foldGuides,n*3,'foldGuides');
  if (mesh.ambientOcclusion) {
    finiteArray(mesh.ambientOcclusion,n,'ambientOcclusion');
    for(let i=0;i<n;i++) if(mesh.ambientOcclusion[i]<0||mesh.ambientOcclusion[i]>1)throw new RangeError('AO must be in [0,1]');
  }
  const indexes=mesh.indices??Array.from({length:n},(_,i)=>i);
  if (indexes.length%3) throw new RangeError('indices must contain triples');
  const faces:[number,number,number][]=[];
  for(let j=0;j<indexes.length;j+=3){
    const ids=[indexes[j],indexes[j+1],indexes[j+2]] as const;
    if(ids.some(i=>!Number.isSafeInteger(i)||i<0||i>=n))throw new RangeError('mesh index out of range');
    faces.push([...ids]);
  }
  const normals=vertexNormals(mesh,faces,n);
  const dir=new Array<number>(width*height*3).fill(0),shade=new Array<number>(width*height).fill(1);
  const seen=new Uint8Array(width*height);let covered=0,degenerate=0;
  for(const ids of faces){
    const frame=faceFrame(mesh,normals,ids);
    if(!frame){degenerate++;continue;}
    const uv=frame.uv;
    const bbox=[Math.min(...uv.map(p=>p[0])),Math.min(...uv.map(p=>p[1])),Math.max(...uv.map(p=>p[0])),Math.max(...uv.map(p=>p[1]))];
    const x0=Math.max(0,Math.ceil(bbox[0]*width-.5)),x1=Math.min(width-1,Math.floor(bbox[2]*width-.5));
    const y0=Math.max(0,Math.ceil(bbox[1]*height-.5)),y1=Math.min(height-1,Math.floor(bbox[3]*height-.5));
    if(x1<x0||y1<y0)continue;
    // Convert eigenvector in orthonormal tangent coordinates to UV. As with all
    // line fields we store double-angle components, never signed vectors.
    const [k11,k12,k22]=frame.eigen,mid=(k11+k22)/2,delta=Math.hypot((k11-k22)/2,k12);
    const p=mid+delta,m=mid-delta,lam=(options.direction??'along-fold')==='along-fold'
      ? (Math.abs(p)<Math.abs(m)?p:m) : (Math.abs(p)>Math.abs(m)?p:m);
    const local=Math.abs(k12)>EPS ? unit(k12,lam-k11) : (Math.abs(k11-lam)<=Math.abs(k22-lam)?[1,0] as const:[0,1] as const);
    const automatic=local ? frame.tangentToUV(local[0],local[1]) : null;
    const strength=Math.min(1,Math.abs(p-m)/(Math.abs(p)+Math.abs(m)+1e-6));
    const qGuides=mesh.foldGuides ? ids.map(i=>{
      const t=frame.xyzToUV(triple(mesh.foldGuides!,i));
      return t ? [t[0]*t[0]-t[1]*t[1],2*t[0]*t[1],1] as const : [0,0,0] as const;
    }) : null;
    const source=automatic && strength>.01 ? [automatic[0]**2-automatic[1]**2,2*automatic[0]*automatic[1],strength] : [0,0,0];
    const [a,b,d]=uv;
    const denom=(b[1]-d[1])*(a[0]-d[0])+(d[0]-b[0])*(a[1]-d[1]);
    if(Math.abs(denom)<EPS){degenerate++;continue;}
    for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
      const tx=(x+.5)/width,ty=(y+.5)/height;
      const wa=((b[1]-d[1])*(tx-d[0])+(d[0]-b[0])*(ty-d[1]))/denom;
      const wb=((d[1]-a[1])*(tx-d[0])+(a[0]-d[0])*(ty-d[1]))/denom;
      const wc=1-wa-wb;
      if(Math.min(wa,wb,wc)<-1e-8)continue;
      const pos=y*width+x;
      const interior=Math.min(wa,wb,wc)>1e-7;
      if(seen[pos]){
        // Shared triangle edges can cross pixel centers. Reject overlapping
        // islands only when both triangles cover the texel interior.
        if((options.overlap??'error')==='error' && interior && seen[pos]===2)
          throw new RangeError(`Overlapping UV islands at texel ${x},${y}`);
        continue;
      }
      seen[pos]=interior?2:1;covered++;
      const weighted=qGuides ? [0,1,2].map(k=>wa*qGuides[0][k]+wb*qGuides[1][k]+wc*qGuides[2][k]) : source;
      const q=unit(weighted[0],weighted[1]);
      const confidence=q ? (qGuides ? Math.min(1,Math.hypot(weighted[0],weighted[1])) : weighted[2]) : 0;
      if(q){dir[3*pos]=q[0]*confidence;dir[3*pos+1]=q[1]*confidence;dir[3*pos+2]=confidence;}
      if(mesh.ambientOcclusion)shade[pos]=wa*mesh.ambientOcclusion[ids[0]]+wb*mesh.ambientOcclusion[ids[1]]+wc*mesh.ambientOcclusion[ids[2]];
    }
  }
  return {direction:{width,height,channels:3,data:dir},shade:{width,height,channels:1,data:shade},
    stats:Object.freeze({triangles:faces.length,coveredTexels:covered,degenerateTriangles:degenerate})};
}

/** Bilinear lookup in the stored line field; invalid UV/low confidence stops tracing. */
export function sampleFlow(atlas: FlowAtlas, at: FlowPoint, minConfidence=.15): FlowPoint|null {
  const im=atlas.direction, {width:w,height:h,data}=im;
  const px=at[0]*w-.5,py=at[1]*h-.5;
  if(!Number.isFinite(px)||!Number.isFinite(py)||at[0]<0||at[0]>1||at[1]<0||at[1]>1)return null;
  const x0=Math.floor(px),y0=Math.floor(py),fx=px-x0,fy=py-y0;
  let qx=0,qy=0,confidence=0;
  for(const [x,y,weight] of [[x0,y0,(1-fx)*(1-fy)],[x0+1,y0,fx*(1-fy)],[x0,y0+1,(1-fx)*fy],[x0+1,y0+1,fx*fy]]){
    if(x<0||y<0||x>=w||y>=h)continue;
    const i=(y*w+x)*3;qx+=data[i]*weight;qy+=data[i+1]*weight;confidence+=data[i+2]*weight;
  }
  const q=confidence>=minConfidence ? unit(qx,qy) : null;
  const angle=q ? Math.atan2(q[1],q[0])/2 : 0;
  return q ? [Math.cos(angle),Math.sin(angle)] : null;
}

function interpolateShade(atlas: FlowAtlas, at: FlowPoint):number {
  const im=atlas.shade, x=Math.max(0,Math.min(im.width-1,at[0]*im.width-.5)),y=Math.max(0,Math.min(im.height-1,at[1]*im.height-.5));
  const ix=Math.floor(x),iy=Math.floor(y),sx=x-ix,sy=y-iy;
  const a=im.data[iy*im.width+ix],b=im.data[iy*im.width+Math.min(im.width-1,ix+1)];
  const c=im.data[Math.min(im.height-1,iy+1)*im.width+ix],d=im.data[Math.min(im.height-1,iy+1)*im.width+Math.min(im.width-1,ix+1)];
  return Math.max(0,Math.min(1,(a*(1-sx)+b*sx)*(1-sy)+(c*(1-sx)+d*sx)*sy));
}

/** Midpoint integration with sign continuity (line fields have no arrow). */
export function traceFlow(atlas: FlowAtlas, options: FlowTraceOptions): FlowTracePoint[] {
  const {seed,length,step}=options;
  if(!Number.isFinite(length)||length<=0||!Number.isFinite(step)||step<=0||!Number.isFinite(seed[0])||!Number.isFinite(seed[1]))throw new RangeError('Finite positive length/step and finite seed required');
  if(length/step>4096)throw new RangeError('Flow trace exceeds the 4096-step bound');
  const confidence=options.minConfidence??.15,turn=options.maxTurnDegrees??70;
  if(!Number.isFinite(confidence)||confidence<0||confidence>1||!Number.isFinite(turn)||turn<=0||turn>180)throw new RangeError('Invalid tracing confidence/turn');
  const initial=sampleFlow(atlas,seed,confidence);if(!initial)return [];
  const orient=(p:FlowPoint,previous:FlowPoint):FlowPoint|null=>{
    const v=sampleFlow(atlas,p,confidence);if(!v)return null;
    return v[0]*previous[0]+v[1]*previous[1]>=0?v:[-v[0],-v[1]];
  };
  const start=initial;
  const grow=(sign:number):FlowPoint[]=>{
    const out:FlowPoint[]=[];let p:FlowPoint=seed,previous:FlowPoint=[sign*start[0],sign*start[1]];
    let distance=0;
    while(distance<length/2-1e-12){
      const h=Math.min(step,length/2-distance),d0=orient(p,previous);if(!d0)break;
      const midpoint:[number,number]=[p[0]+h*d0[0]/2,p[1]+h*d0[1]/2];
      const dm=orient(midpoint,d0);if(!dm||d0[0]*dm[0]+d0[1]*dm[1]<Math.cos(turn*Math.PI/180))break;
      const next:FlowPoint=[p[0]+h*dm[0],p[1]+h*dm[1]];
      if(!sampleFlow(atlas,next,confidence))break;
      out.push(next);p=next;previous=dm;distance+=h;
    }
    return out;
  };
  const coords=[...grow(-1).reverse(),seed,...grow(1)];
  const taper=options.taper??.18;
  if(!Number.isFinite(taper)||taper<0||taper>1)throw new RangeError('Invalid stroke taper');
  return coords.map((at,i)=>({at,pressure:taper+(1-taper)*Math.sin(Math.PI*i/(coords.length-1||1))}));
}

/** Generate ordinary portable Moonweave stroke inputs, not another mark grammar. */
export function guidedStrokes(atlas: FlowAtlas, options: GuidedStrokeOptions) {
  const {seeds,brush,color,radius,opacity=1,aspect=.55,spacing=.4,shadowStrength=.45,zone}=options;
  if(!Array.isArray(seeds)||seeds.length>16384||!brush||!Array.isArray(color)||color.length!==3||!color.every(v=>Number.isFinite(v)&&v>=0&&v<=1))throw new RangeError('Invalid guided stroke inputs');
  for(const n of [radius,opacity,aspect,spacing,shadowStrength]) if(!Number.isFinite(n))throw new RangeError('Guided controls must be finite');
  if(radius<=0||aspect<=0||spacing<=0||opacity<0||opacity>1||shadowStrength<0||shadowStrength>1)throw new RangeError('Guided controls out of range');
  return seeds.flatMap(seed=>{
    const points=traceFlow(atlas,{seed,length:options.length,step:options.step,minConfidence:options.minConfidence,maxTurnDegrees:options.maxTurnDegrees,taper:options.taper});
    if(points.length<2)return [];
    const shade=interpolateShade(atlas,seed),scale=1-shadowStrength*(1-shade);
    const tinted:[number,number,number]=[color[0]*scale,color[1]*scale,color[2]*scale];
    return [{kind:'stroke' as const,brush,color:tinted,opacity,points,radius,aspect,spacing,...(zone?{zone}:{})}];
  });
}