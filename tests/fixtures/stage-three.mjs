export * from 'three';
import {WebGLRenderTarget} from 'three';

// Only the GPU boundary is doubled. Stage geometry, controls and scopes are real.
export const renderers = [];
export class WebGLRenderer {
  constructor({canvas, context}) {
    this.canvas = canvas; this.context = context;
    this.debug = {}; this.shadowMap = {};
    this.capabilities = {getMaxAnisotropy: () => 4};
    this.info = {memory: {textures: 0, geometries: 0}, programs: []};
    this.scenes = []; this.disposals = 0; this.pixelRatio = 1;
    renderers.push(this);
  }
  getContext() {return this.context;}
  setPixelRatio(value) {this.pixelRatio = value;}
  getPixelRatio() {return this.pixelRatio;}
  setSize(width, height) {this.size = {width, height};}
  render(scene, camera) {this.scenes.push(scene); this.camera = camera;}
  dispose() {this.disposals++;}
}
export class PMREMGenerator {
  fromScene() {return new WebGLRenderTarget(1, 1);}
  dispose() {}
}
