import type * as THREE from 'three';

/** Inject only the host capabilities each resource owner consumes. */
export type PaintTextureEngine = Readonly<Pick<typeof THREE,
  'DataTexture' | 'RGBAFormat' | 'UnsignedByteType' | 'RepeatWrapping'
  | 'LinearFilter' | 'LinearMipmapLinearFilter'
>> & Readonly<{
  NoColorSpace?: typeof THREE.NoColorSpace;
  LinearEncoding?: number;
}>;
export type TexturingEngine = PaintTextureEngine & Readonly<Pick<typeof THREE,
  'MeshPhysicalMaterial' | 'Vector2' | 'Vector3' | 'Vector4' | 'Matrix3' | 'Matrix4'
  | 'FrontSide' | 'BackSide' | 'DoubleSide' | 'FloatType' | 'NearestFilter' | 'ClampToEdgeWrapping'
>>;
export type CoordinateEngine = Readonly<Pick<typeof THREE,
  'Matrix4' | 'Matrix3' | 'BufferAttribute' | 'Vector3'
>>;
