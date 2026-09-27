// Transport layer: the only renderer of vehicle and target symbols. Three.js draws textured
// squares inside a MapLibre custom layer, sharing its camera and WebGL context. Positions are
// MercatorCoordinate scaled to world pixels, so a size in world pixels is a size in screen pixels
// at every zoom. Bitmaps come from map-symbols.js and are cached per look, so a poll re-uses them.

import * as maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import {drawSymbol, symbolKey} from './map-symbols.js';

export function createTransportLayer() {
  const plane = new THREE.PlaneGeometry(1, 1);
  const sprites = new Map(); // look key → {material, box}
  const sprite = look => {
    const key = symbolKey(look);
    if (!sprites.has(key)) {
      const {canvas, box} = drawSymbol(look, Math.max(2, globalThis.devicePixelRatio || 1));
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false;
      texture.minFilter = THREE.LinearFilter;
      texture.premultiplyAlpha = true;
      const material = new THREE.MeshBasicMaterial({map: texture, transparent: true, premultipliedAlpha: true,
        depthTest: false, depthWrite: false, side: THREE.DoubleSide});
      sprites.set(key, {material, box});
    }
    return sprites.get(key);
  };
  // One dimmed copy per material and opacity, reused across polls.
  const fadedCache = new Map();
  const faded = (base, opacity) => {
    const key = `${base.id}|${opacity}`;
    if (!fadedCache.has(key)) { const copy = base.clone(); copy.opacity = opacity; fadedCache.set(key, copy); }
    return fadedCache.get(key);
  };
  return {
    id: 'transport-three', type: 'custom', renderingMode: '3d',
    onAdd(map, gl) {
      this.map = map;
      this.scene = new THREE.Scene();
      this.camera = new THREE.Camera();
      this.renderer = new THREE.WebGLRenderer({canvas: map.getCanvas(), context: gl, antialias: true});
      this.renderer.autoClear = false;
      this.meshes = [];
    },
    // symbols: [{lon, lat, look, rotation?}], drawn in order (later on top). `rotation` is degrees
    // clockwise from north, for a direction mark drawn as its own symbol; the bus icon stays upright.
    // symbols: [{lon, lat, look, rotation?, opacity?}] — opacity < 1 draws a quiet (dimmed) symbol.
    setSymbols(symbols) {
      if (!this.scene) return;
      for (const mesh of this.meshes) this.scene.remove(mesh);
      this.meshes = symbols.map((symbol, index) => {
        const {material: base, box} = sprite(symbol.look);
        const material = symbol.opacity < 1 ? faded(base, symbol.opacity) : base;
        const mesh = new THREE.Mesh(plane, material);
        mesh.userData = {coord: maplibregl.MercatorCoordinate.fromLngLat([symbol.lon, symbol.lat], 0), box};
        mesh.rotation.z = ((symbol.rotation ?? 0) * Math.PI) / 180; // with the y flip below, positive turns clockwise on screen
        mesh.renderOrder = index;
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        return mesh;
      });
      this.map.triggerRepaint();
    },
    render(gl, options) {
      const worldSize = 512 * 2 ** this.map.getZoom();
      for (const mesh of this.meshes) {
        const {coord, box} = mesh.userData;
        mesh.position.set(coord.x * worldSize, coord.y * worldSize, 0);
        mesh.scale.set(box, -box, 1); // Mercator y grows southwards: flip so the bitmap is upright
      }
      this.camera.projectionMatrix.fromArray(options.modelViewProjectionMatrix);
      this.renderer.resetState();
      this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      this.renderer.render(this.scene, this.camera);
    },
    onRemove() {
      plane.dispose();
      for (const {material} of sprites.values()) { material.map.dispose(); material.dispose(); }
      this.renderer.dispose();
    },
  };
}
