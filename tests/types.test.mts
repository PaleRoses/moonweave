import * as THREE from 'three';
import {surface, facets, scalar, color, domain, materialGraph, patchGraph, compileGraph, evaluateScalar, splitRecipe} from '@moonweave/surfaces/core';
import {createTexturingSystem, bindSurfaceCoordinates, createPaintTextures} from '@moonweave/surfaces/three';
import type {PaintTextureEngine, TexturingEngine, CoordinateEngine} from '@moonweave/surfaces/three';

const mapped = domain.transform([1,0,0,0, 0,1,0,0, 0,0,1,0, 1,2,3,1]);
const field = facets({...splitRecipe('carapace').mapping, domain: mapped});
const mask = scalar.multiply(scalar.ramp(scalar.axis('y'), -.4, .5), scalar.parameter(.8));
const expression = surface.channels(surface.mix(surface.paint(field, 'carapace'), surface.paint(field, {roughness: .7}), mask), {metalness: 0});
const graph = materialGraph(expression);
compileGraph(graph).cost.textureReads satisfies number;
evaluateScalar(graph, 'n0', {position: [1, 2, 3]}).dx satisfies number;
const fields = createPaintTextures(THREE);
const system = createTexturingSystem(THREE, {fields});
const material = system.createMaterial(graph, {coordinates: 'attribute'});
const strengthId = graph.nodes.find(node => node.kind === 'parameter')!.id;
const paintNode = graph.nodes.find(node => node.kind === 'paint')!;
const paintId = paintNode.id;
const baseId = paintNode.palette.base;
const edited = patchGraph(graph, {[strengthId]: {value: .4}, [paintId]: {style: {roughness: .6}}, [baseId]: {value: [.2, .4, .6]}});
compileGraph(edited).structure.programKey satisfies string;
material.patch({[strengthId]: {value: .6}});
material.setGraph(surface.paint('horn'));
material.update('horn');
material.update({palette: {base: color.srgb('#abcdef')}});
material.update({mapping: {scale: .4}, style: {roughness: .7}});
bindSurfaceCoordinates(THREE, new THREE.SphereGeometry(), {matrix: new THREE.Matrix4()});
material.dispose(); system.dispose(); fields.dispose();

const textureEngine = {
  DataTexture: THREE.DataTexture, RGBAFormat: THREE.RGBAFormat,
  UnsignedByteType: THREE.UnsignedByteType, RepeatWrapping: THREE.RepeatWrapping,
  LinearFilter: THREE.LinearFilter, LinearMipmapLinearFilter: THREE.LinearMipmapLinearFilter,
  NoColorSpace: THREE.NoColorSpace,
} satisfies PaintTextureEngine;
const materialEngine = {
  ...textureEngine, MeshPhysicalMaterial: THREE.MeshPhysicalMaterial,
  FloatType: THREE.FloatType, NearestFilter: THREE.NearestFilter,
  ClampToEdgeWrapping: THREE.ClampToEdgeWrapping,
  Vector2: THREE.Vector2, Vector3: THREE.Vector3, Vector4: THREE.Vector4,
  Matrix3: THREE.Matrix3, Matrix4: THREE.Matrix4,
  FrontSide: THREE.FrontSide, BackSide: THREE.BackSide, DoubleSide: THREE.DoubleSide,
} satisfies TexturingEngine;
const coordinateEngine = {
  Matrix4: THREE.Matrix4, Matrix3: THREE.Matrix3,
  BufferAttribute: THREE.BufferAttribute, Vector3: THREE.Vector3,
} satisfies CoordinateEngine;
const narrowFields = createPaintTextures(textureEngine);
createTexturingSystem(materialEngine, {fields: narrowFields}).dispose();
bindSurfaceCoordinates(coordinateEngine, new THREE.SphereGeometry());
narrowFields.dispose();

// @ts-expect-error A scalar expression cannot occupy a surface input.
surface.mix(mask, surface.paint(), 0.5);
// @ts-expect-error Editable parameters are numeric.
scalar.parameter('0.5');
// @ts-expect-error Only material channels are accepted.
surface.channels(surface.paint(), {unknown: 1});
// @ts-expect-error A borrowed field owns its generation settings.
createTexturingSystem(THREE, {fields, seed: 1});
// @ts-expect-error Value patches do not rewire the graph.
patchGraph(graph, {[paintId]: {field: 'anotherField'}});
// @ts-expect-error Editable values remain numeric.
material.patch({[strengthId]: {value: '0.6'}});
const {Vector4: omittedVector, ...incompleteMaterialEngine} = materialEngine;
// @ts-expect-error Material bindings require all five vector/matrix constructors.
createTexturingSystem(incompleteMaterialEngine);
const {FloatType: omittedFloat, ...paintOnlyMaterialEngine} = materialEngine;
// @ts-expect-error The complete texturing engine includes image-field capabilities.
createTexturingSystem(paintOnlyMaterialEngine);
// @ts-expect-error Texture creation requires formats and filters as well as the constructor.
createPaintTextures({DataTexture: THREE.DataTexture});
// @ts-expect-error Coordinate baking requires the BufferAttribute constructor.
bindSurfaceCoordinates({Matrix3: THREE.Matrix3, Matrix4: THREE.Matrix4, Vector3: THREE.Vector3}, new THREE.SphereGeometry());
