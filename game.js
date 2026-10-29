import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------------------------------------------------------------- setup
const params = new URLSearchParams(location.search);
const isTouch = matchMedia('(pointer: coarse)').matches;

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xcfe6ff, 70, 220);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 600);

const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- lights
scene.add(new THREE.HemisphereLight(0xdcefff, 0x7d6f5c, 1.1));

const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
sun.position.set(-38, 60, -48);
sun.target.position.set(-6, 0, 0);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 1, far: 200 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

// Interior fill lights (no shadows) so the rooms under the roof stay readable.
for (const [x, z] of [[3.5, 0], [-3, 6], [3.5, 12], [-2, 18], [-11.5, -9], [-9.2, -1.5], [-15, -4], [-15.8, 4.5], [-15.8, 15], [-9.4, 12]]) {
  const l = new THREE.PointLight(0xfff4e2, 9, 13, 1.6);
  l.position.set(x, 3.0, z);
  scene.add(l);
}

// ---------------------------------------------------------------- sky
{
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(400, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x3d8fe8) }, horizon: { value: new THREE.Color(0xd6ecff) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vP; void main(){ float h = clamp(vP.y*1.6,0.0,1.0); gl_FragColor = vec4(mix(horizon, top, pow(h,0.7)),1.0); }',
    })
  );
  sky.renderOrder = -1;
  scene.add(sky);

  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x9fb6cc, fog: false });
  const puff = new THREE.IcosahedronGeometry(1, 1);
  const rnd = mulberry32(7);
  for (let i = 0; i < 14; i++) {
    const c = new THREE.Group();
    for (let k = 0; k < 5; k++) {
      const p = new THREE.Mesh(puff, cloudMat);
      p.position.set((k - 2) * 4 + rnd() * 2, rnd() * 2, rnd() * 3);
      p.scale.setScalar(3 + rnd() * 3);
      c.add(p);
    }
    const a = rnd() * Math.PI * 2, r = 120 + rnd() * 120;
    c.position.set(Math.cos(a) * r, 55 + rnd() * 30, Math.sin(a) * r);
    c.scale.y = 0.5;
    scene.add(c);
  }
}

// ---------------------------------------------------------------- helpers
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  return t;
}

const collidables = []; // extra meshes (outside the GLB) that block the player and camera

function box(x1, x2, y1, y2, z1, z2, mat, { collide = true, cast = true } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(x2 - x1, y2 - y1, z2 - z1), mat);
  m.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
  m.castShadow = cast;
  m.receiveShadow = true;
  scene.add(m);
  if (collide) collidables.push(m);
  return m;
}

// ---------------------------------------------------------------- layout
// The GLB is mirrored (x -> -x) so it matches the walk-in video: entering from the lobby you
// walk north (+z) down the entrance corridor; the classroom wing and trophies are on your right
// (-x), reception is at the end, and the open office with the glass cabins is to the left (+x).
//
//   lobby annex      x -15.6..-7.4   z -12..-6   (outdoor entrance on z = -12)
//   entrance corr.   x -11..-7.4     z -6..1.2   (office door with fingerprint on z = -6)
//   reception        x -11..-7.3     z 1.2..5
//   classroom hall   x -19..-11      z -1.8..-0.2, then north corridor x -12.6..-11 up to z 21
//   open office      x -7.3..7.25    z -7.2..21  (the GLB main wing)
const LOBBY = { x1: -15.6, x2: -7.4, z1: -12, z2: -6 };
const OUT_DOOR = { x1: -11.6, x2: -9.0, z: -12 }; // outdoor sliding doors
const OFFICE_DOOR = { x1: -10.8, x2: -9.6, z: -6 }; // fingerprint glass door
const HALL_Z1 = -1.8, HALL_Z2 = -0.2; // classroom hallway
const ROOF_Y = 3.61;

// ---------------------------------------------------------------- outdoor world
const SPAWN = new THREE.Vector3(-10.3, 0, -26);
const SPAWN_YAW = Math.PI; // camera south of the player, looking north at the entrance

{
  const rnd = mulberry32(42);
  const grass = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#5f9a3e'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      const v = 70 + rnd() * 70 | 0;
      g.fillStyle = `rgba(${v * 0.55 | 0},${v + 40},${v * 0.35 | 0},0.35)`;
      g.fillRect(rnd() * w, rnd() * h, 2, 3 + rnd() * 4);
    }
  }, [90, 90]);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardMaterial({ map: grass, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  ground.receiveShadow = true;
  scene.add(ground);

  const flat = (x1, x2, z1, z2, y, mat) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, z2 - z1), mat);
    p.rotation.x = -Math.PI / 2;
    p.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
    p.receiveShadow = true;
    scene.add(p);
    return p;
  };
  const paving = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#c9c4ba'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 400; i++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.06})`; g.fillRect(rnd() * w, rnd() * h, 6, 6); }
    g.strokeStyle = '#a8a298'; g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64, h); g.stroke(); g.beginPath(); g.moveTo(0, i * 64); g.lineTo(w, i * 64); g.stroke(); }
  }, [6, 6]);
  flat(-22, 2, -36, -12, -0.015, new THREE.MeshStandardMaterial({ map: paving, roughness: 0.85 }));

  // paved walkway around the building
  const walkMat = new THREE.MeshStandardMaterial({ color: 0xbdb6aa, roughness: 0.9 });
  for (const [x1, x2, z1, z2] of [[-22, 10, 21.2, 24], [-22, -19.2, -12, 24], [7.4, 10, -10.5, 24], [-7.3, 10, -10.5, -7.5]]) flat(x1, x2, z1, z2, -0.02, walkMat);

  const asphalt = canvasTex(128, 512, (g, w, h) => {
    g.fillStyle = '#3a3d42'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 1500; i++) { g.fillStyle = `rgba(255,255,255,${rnd() * 0.05})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
    g.fillStyle = '#f2f2f2'; g.fillRect(w / 2 - 3, 0, 6, h / 2);
    g.fillStyle = '#e8e8e8'; g.fillRect(4, 0, 4, h); g.fillRect(w - 8, 0, 4, h);
  }, [1, 40]);
  const road = new THREE.Mesh(new THREE.PlaneGeometry(10, 400), new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.95 }));
  road.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
  road.position.set(0, -0.012, -43);
  road.receiveShadow = true;
  scene.add(road);

  // Roblox-style spawn pad
  const padTex = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#5b6470'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#2f343b'; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
    g.fillStyle = '#e9edf2';
    g.beginPath(); g.arc(w / 2, h / 2, 70, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5b6470';
    g.beginPath(); g.arc(w / 2, h / 2, 52, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#e9edf2'; g.font = 'bold 54px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('S', w / 2, h / 2 + 3);
  });
  const padSide = new THREE.MeshStandardMaterial({ color: 0x4a525c });
  const pad = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.2, 3.2), [padSide, padSide, new THREE.MeshStandardMaterial({ map: padTex }), padSide, padSide, padSide]);
  pad.position.set(SPAWN.x, 0.0, SPAWN.z);
  pad.receiveShadow = true;
  scene.add(pad);
  collidables.push(pad);

  // trees
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
  const leafMats = [0x3f8f3a, 0x4fa043, 0x2f7a35].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.9, flatShading: true }));
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 2.4, 7);
  const leafGeo = new THREE.IcosahedronGeometry(1.6, 0);
  const blocked = (x, z) => (x > -24 && x < 12 && z > -14 && z < 26) || (x > -25 && x < 5 && z > -39 && z < -10) || (z > -50 && z < -37);
  let placed = 0;
  while (placed < 70) {
    const x = -90 + rnd() * 160, z = -80 + rnd() * 150;
    if (blocked(x, z)) continue;
    const t = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 1.2; trunk.castShadow = true;
    const s = 0.8 + rnd() * 0.7;
    const l1 = new THREE.Mesh(leafGeo, leafMats[placed % 3]);
    l1.position.y = 3.0; l1.castShadow = true;
    const l2 = new THREE.Mesh(leafGeo, leafMats[(placed + 1) % 3]);
    l2.position.set(0.5, 3.9, 0.2); l2.scale.setScalar(0.7); l2.castShadow = true;
    t.add(trunk, l1, l2);
    t.position.set(x, 0, z); t.scale.setScalar(s); t.rotation.y = rnd() * 6;
    scene.add(t);
    collidables.push(trunk);
    placed++;
  }

  // street lamps around the plaza
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, metalness: 0.5, roughness: 0.4 });
  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2c8, emissiveIntensity: 1.5 });
  for (const [x, z] of [[-18, -16], [-2.5, -16], [-18, -32], [-2.5, -32]]) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 4, 8), poleMat);
    pole.position.set(x, 2, z); pole.castShadow = true;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), lampMat);
    lamp.position.set(x, 4.1, z);
    scene.add(pole, lamp);
    collidables.push(pole);
  }

  // benches on the plaza
  const benchWood = new THREE.MeshStandardMaterial({ color: 0x9a6236, roughness: 0.7 });
  for (const x of [-16.5, -4]) {
    box(x - 0.3, x + 0.3, 0.42, 0.5, -25.5, -22.5, benchWood);
    box(x - 0.25, x + 0.25, 0, 0.42, -25.3, -25.1, poleMat);
    box(x - 0.25, x + 0.25, 0, 0.42, -22.9, -22.7, poleMat);
  }
}

// ---------------------------------------------------------------- building shell (facades, roof, new interior walls)
const wallMat = new THREE.MeshStandardMaterial({ color: 0xe8e3d8, roughness: 0.9 });
const charcoalMat = new THREE.MeshStandardMaterial({ color: 0x3a3e45, roughness: 0.85 });
const trimMat = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.5 });
const woodMat = new THREE.MeshStandardMaterial({ color: 0xb98a5a, roughness: 0.6 });
const darkTileMat = new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.4 });
const graniteMat = new THREE.MeshStandardMaterial({ color: 0x9e8579, roughness: 0.25 });
const steelMat = new THREE.MeshStandardMaterial({ color: 0xb9bdc3, metalness: 0.85, roughness: 0.3 });
const extGlass = new THREE.MeshStandardMaterial({ color: 0x9cc7e0, roughness: 0.05, metalness: 0.3, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide });
const roofMat = new THREE.MeshStandardMaterial({ color: 0x9a9c9f, roughness: 0.95 });

function glassBand(x1, x2, z1, z2, y1, y2, alongX) {
  box(x1, x2, y1, y2, z1, z2, extGlass, { cast: false });
  const len = alongX ? x2 - x1 : z2 - z1;
  const n = Math.max(1, Math.round(len / 1.5));
  for (let i = 0; i <= n; i++) {
    const t = (alongX ? x1 : z1) + (len * i) / n;
    if (alongX) box(t - 0.03, t + 0.03, y1, y2, z1 - 0.02, z2 + 0.02, trimMat, { collide: false });
    else box(x1 - 0.02, x2 + 0.02, y1, y2, t - 0.03, t + 0.03, trimMat, { collide: false });
  }
}
// solid wall along x (at z) or along z (at x), with door gaps [a, b] and a header above each gap
function wallX(x1, x2, z, gaps = [], mat = wallMat, head = 2.2, t = 0.12) {
  let x = x1;
  for (const [a, b] of gaps) { if (a > x) box(x, a, 0, ROOF_Y, z - t / 2, z + t / 2, mat); box(a, b, head, ROOF_Y, z - t / 2, z + t / 2, mat); x = b; }
  if (x2 > x) box(x, x2, 0, ROOF_Y, z - t / 2, z + t / 2, mat);
}
function wallZ(z1, z2, x, gaps = [], mat = wallMat, head = 2.2, t = 0.12) {
  let z = z1;
  for (const [a, b] of gaps) { if (a > z) box(x - t / 2, x + t / 2, 0, ROOF_Y, z, a, mat); box(x - t / 2, x + t / 2, head, ROOF_Y, a, b, mat); z = b; }
  if (z2 > z) box(x - t / 2, x + t / 2, 0, ROOF_Y, z, z2, mat);
}

// facades above the model's 1.2 m parapets
glassBand(-19.06, 7.05, 20.97, 21.03, 1.26, 2.6, true);   // north side, whole building
box(-19.06, 7.12, 2.6, ROOF_Y, 20.94, 21.06, wallMat);
glassBand(-19.03, -18.97, -6.06, 21.06, 1.2, 2.6, false); // west side (x = -19)
box(-19.06, -18.94, 2.6, ROOF_Y, -6.06, 21.06, wallMat);
// south side of the classroom wing (x -19..-15.6) is exterior; the rest borders the lobby
box(-19.06, -15.6, 0, 1.2, -6.06, -5.94, wallMat);
glassBand(-19.06, -15.6, -6.03, -5.97, 1.2, 2.6, true);
box(-19.06, -15.6, 2.6, ROOF_Y, -6.06, -5.94, wallMat);
wallX(-15.6, -7.4, -6, [[OFFICE_DOOR.x1, OFFICE_DOOR.x2]], wallMat, 2.4);
box(-7.46, -6.85, 0, ROOF_Y, -6.06, -4.9, wallMat); // filler where the curved front ends

// lobby annex
wallZ(LOBBY.z1, LOBBY.z2, LOBBY.x1);
wallZ(LOBBY.z1, LOBBY.z2, LOBBY.x2);
for (const [x1, x2] of [[LOBBY.x1 - 0.06, OUT_DOOR.x1], [OUT_DOOR.x2, LOBBY.x2 + 0.06]]) {
  box(x1, x2, 0, 1.0, LOBBY.z1 - 0.06, LOBBY.z1 + 0.06, wallMat);
  glassBand(x1, x2, LOBBY.z1 - 0.03, LOBBY.z1 + 0.03, 1.0, 2.6, true);
}
box(LOBBY.x1 - 0.06, LOBBY.x2 + 0.06, 2.6, ROOF_Y, LOBBY.z1 - 0.06, LOBBY.z1 + 0.06, wallMat);
box(OUT_DOOR.x1 - 0.12, OUT_DOOR.x1, 0, 2.6, LOBBY.z1 - 0.1, LOBBY.z1 + 0.1, trimMat);
box(OUT_DOOR.x2, OUT_DOOR.x2 + 0.12, 0, 2.6, LOBBY.z1 - 0.1, LOBBY.z1 + 0.1, trimMat);
flat0(LOBBY.x1, LOBBY.x2, LOBBY.z1, LOBBY.z2, -0.004, graniteMat);
// lift on the lobby's east wall (left of the office door, as in the video)
box(LOBBY.x2 - 0.1, LOBBY.x2 - 0.06, 0, 2.35, -9.2, -7.2, trimMat, { collide: false });
box(LOBBY.x2 - 0.12, LOBBY.x2 - 0.1, 0.02, 2.25, -9.1, -8.21, steelMat, { collide: false });
box(LOBBY.x2 - 0.12, LOBBY.x2 - 0.1, 0.02, 2.25, -8.19, -7.3, steelMat, { collide: false });
box(LOBBY.x2 - 0.12, LOBBY.x2 - 0.08, 1.05, 1.25, -6.95, -6.8, steelMat, { collide: false });

// entrance corridor: white wall on the left, charcoal wall on the right with the classroom opening
wallZ(-6, 1.2, -7.4);
wallZ(-6, 5, -11, [[HALL_Z1, HALL_Z2]], charcoalMat, 2.5);
// wood frame around the classroom opening (corridor side)
box(-10.94, -10.84, 0, 2.6, HALL_Z1 - 0.12, HALL_Z1, woodMat, { collide: false });
box(-10.94, -10.84, 0, 2.6, HALL_Z2, HALL_Z2 + 0.12, woodMat, { collide: false });
box(-10.94, -10.84, 2.5, 2.6, HALL_Z1, HALL_Z2, woodMat, { collide: false });
// black mesh-grid ceiling over the corridor
{
  const meshMat = new THREE.MeshStandardMaterial({ color: 0x18191c, roughness: 0.8 });
  box(-10.94, -7.46, 3.2, 3.22, -6, 1.2, meshMat, { collide: false, cast: false });
  for (let z = -5.4; z < 1.2; z += 0.6) box(-10.94, -7.46, 3.05, 3.2, z - 0.02, z + 0.02, meshMat, { collide: false, cast: false });
  for (let x = -10.4; x < -7.5; x += 0.6) box(x - 0.02, x + 0.02, 3.05, 3.2, -6, 1.2, meshMat, { collide: false, cast: false });
  for (const z of [-4.5, -1.5, 0.8]) box(-9.3, -9.1, 3.03, 3.05, z - 0.1, z + 0.1, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3dd, emissiveIntensity: 2 }), { collide: false, cast: false });
}

// classroom hallway (runs west from the opening) and the north corridor to the old classrooms
wallX(-19, -11, HALL_Z1, [[-17.6, -16.66], [-13.9, -12.96]]);
wallX(-19, -12.6, HALL_Z2);
wallZ(-6, HALL_Z1, -15);                                    // between classrooms 1 and 2
wallZ(HALL_Z2, 9, -12.6, [[3.5, 4.44]]);                    // training hall door
flat0(-19, -11, HALL_Z1, HALL_Z2, 0.003, darkTileMat);
flat0(-12.6, -11.06, HALL_Z2, 9, 0.003, darkTileMat);

// roofs + parapets
box(-7.4, 7.35, ROOF_Y, 3.85, -7.45, 21.2, roofMat);
box(-19.2, -6.85, ROOF_Y, 3.85, -6.2, 21.2, roofMat);
box(LOBBY.x1 - 0.15, LOBBY.x2 + 0.15, ROOF_Y, 3.85, LOBBY.z1 - 0.15, LOBBY.z2 + 0.1, roofMat);
for (const [x1, x2, z1, z2] of [[-19.2, 7.35, 21.0, 21.2], [7.15, 7.35, -7.45, 21.2], [-19.2, -19.0, -6.2, 21.2], [-7.4, 7.35, -7.45, -7.25],
  [LOBBY.x1 - 0.15, LOBBY.x2 + 0.15, LOBBY.z1 - 0.15, LOBBY.z1 + 0.05], [-19.2, LOBBY.x1, -6.2, -6.0]]) {
  box(x1, x2, 3.85, 4.1, z1, z2, wallMat, { collide: false });
}
// under-floor tile plane: the model's floor slab has a few missing triangles
flat0(-19, 7.25, -6, 21, -0.012, new THREE.MeshStandardMaterial({ color: 0xa9a69e, roughness: 0.4 }));
// rooftop AC units
for (const [x, z] of [[3, 4], [-2, 12], [-13, 4], [-15, 16]]) box(x - 0.7, x + 0.7, 3.85, 4.75, z - 0.5, z + 0.5, new THREE.MeshStandardMaterial({ color: 0xcfd3d6, roughness: 0.6 }), { collide: false });
// entrance canopy
{
  const zc = LOBBY.z1 - 0.06;
  box(OUT_DOOR.x1 - 0.9, OUT_DOOR.x2 + 0.9, 2.68, 2.82, zc - 2.9, zc, trimMat);
  box(OUT_DOOR.x1 - 0.8, OUT_DOOR.x1 - 0.65, 0, 2.68, zc - 2.8, zc - 2.65, trimMat);
  box(OUT_DOOR.x2 + 0.65, OUT_DOOR.x2 + 0.8, 0, 2.68, zc - 2.8, zc - 2.65, trimMat);
}
// HACA sign above the entrance
{
  const tex = canvasTex(512, 160, (g, w, h) => {
    g.fillStyle = '#1d2026'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ffffff'; g.font = 'bold 96px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('HACA', w / 2, h / 2 - 12);
    g.font = '28px Fredoka, sans-serif'; g.fillStyle = '#7fd0ff';
    g.fillText('Haris & Co. Academy', w / 2, h - 24);
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 1.1), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 }));
  sign.rotation.y = Math.PI; // faces south (-z)
  sign.position.set((OUT_DOOR.x1 + OUT_DOOR.x2) / 2, 3.18, LOBBY.z1 - 0.08);
  scene.add(sign);
}

function flat0(x1, x2, z1, z2, y, mat) {
  const p = new THREE.Mesh(new THREE.PlaneGeometry(x2 - x1, z2 - z1), mat);
  p.rotation.x = -Math.PI / 2;
  p.position.set((x1 + x2) / 2, y, (z1 + z2) / 2);
  p.receiveShadow = true;
  scene.add(p);
  return p;
}

// ---------------------------------------------------------------- simple classroom furniture (new rooms)
{
  const desk = new THREE.MeshStandardMaterial({ color: 0xc8a77c, roughness: 0.6 });
  const chair = new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.6 });
  const board = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.3 });
  const geos = new Map();
  const add = (x1, x2, y1, y2, z1, z2, mat) => {
    const g = new THREE.BoxGeometry(x2 - x1, y2 - y1, z2 - z1).translate((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    if (!geos.has(mat)) geos.set(mat, []);
    geos.get(mat).push(g);
  };
  // students face -z (board on the south wall) or +z (board on the north wall)
  const room = (x1, x2, z1, z2, rows, cols, facing) => {
    const bz = facing < 0 ? z1 + 0.08 : z2 - 0.08, off = -facing * 0.03; // board sits on the room side
    add(x1 + 0.8, x2 - 0.8, 0.95, 2.05, bz - 0.02, bz + 0.02, trimMat);
    add(x1 + 0.85, x2 - 0.85, 1.0, 2.0, bz + off - 0.01, bz + off + 0.01, board);
    const w = (x2 - x1) / cols, d = (z2 - z1 - 2.4) / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const cx = x1 + w * (c + 0.5);
      const cz = facing < 0 ? z1 + 1.2 + d * r : z2 - 1.2 - d * r;
      add(cx - w * 0.36, cx + w * 0.36, 0.72, 0.76, cz - 0.3, cz + 0.3, desk);
      add(cx - w * 0.33, cx - w * 0.3, 0, 0.72, cz - 0.27, cz + 0.27, desk);
      add(cx + w * 0.3, cx + w * 0.33, 0, 0.72, cz - 0.27, cz + 0.27, desk);
      for (const sx of [-0.22, 0.22]) {
        const chz = cz - facing * 0.62;
        add(cx + sx * w - 0.2, cx + sx * w + 0.2, 0.42, 0.48, chz - 0.2, chz + 0.2, chair);
        add(cx + sx * w - 0.03, cx + sx * w + 0.03, 0, 0.42, chz - 0.03, chz + 0.03, chair);
        const bk = chz - facing * 0.2;
        add(cx + sx * w - 0.2, cx + sx * w + 0.2, 0.48, 0.9, bk - 0.03, bk + 0.03, chair);
      }
    }
  };
  room(-15, -11, -6, HALL_Z1, 2, 2, -1);       // Classroom 1
  room(-19, -15, -6, HALL_Z1, 2, 2, -1);       // Classroom 2
  room(-19, -12.6, HALL_Z2, 8.88, 3, 3, 1);    // Training hall
  for (const [mat, list] of geos) {
    const m = new THREE.Mesh(mergeGeometries(list, false), mat);
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    collidables.push(m);
  }
}

// ---------------------------------------------------------------- doors (auto-open)
const doors = [];

function hingeDoor(objs, hinge, openAngle, opts = {}) {
  const pivot = new THREE.Group();
  pivot.position.copy(hinge);
  scene.add(pivot);
  const bb = new THREE.Box3();
  for (const o of objs) { bb.expandByObject(o); pivot.attach(o); }
  doors.push({ kind: 'hinge', pivot, openAngle, t: 0, center: bb.getCenter(new THREE.Vector3()), box: bb, ...opts });
}

// black classroom door with a small glass window (as seen in the video)
function makeDoor(alongX, a, b, at, openAngle) {
  const len = b - a, glassMat = new THREE.MeshStandardMaterial({ color: 0x8fb4c8, roughness: 0.1, transparent: true, opacity: 0.5 });
  const g = new THREE.Group();
  const leaf = new THREE.Mesh(new THREE.BoxGeometry(len, 2.15, 0.04), new THREE.MeshStandardMaterial({ color: 0x1b1c20, roughness: 0.5 }));
  leaf.position.set(len / 2, 1.075, 0);
  const win = new THREE.Mesh(new THREE.BoxGeometry(len * 0.5, 0.6, 0.05), glassMat);
  win.position.set(len / 2, 1.55, 0);
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.03, 0.1), steelMat);
  handle.position.set(len - 0.1, 1.0, 0);
  g.add(leaf, win, handle);
  g.traverse(m => { if (m.isMesh) m.castShadow = true; });
  // the door is built along +x from its hinge; rotate it to run along +z for walls on x
  if (alongX) g.position.set(a, 0, at); else { g.position.set(at, 0, a); g.rotation.y = -Math.PI / 2; }
  scene.add(g);
  g.updateMatrixWorld(true);
  hingeDoor([g], g.position.clone(), openAngle);
}
makeDoor(true, -17.6, -16.66, HALL_Z1, 1.45);  // Classroom 2 (opens south)
makeDoor(true, -13.9, -12.96, HALL_Z1, 1.45);  // Classroom 1
makeDoor(false, 3.5, 4.44, -12.6, -1.45);       // Training hall (opens west)

function slidingDoor() {
  const glass = new THREE.MeshStandardMaterial({ color: 0xaad4ee, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.45, depthWrite: false, side: THREE.DoubleSide });
  const half = (OUT_DOOR.x2 - OUT_DOOR.x1) / 2;
  const mid = (OUT_DOOR.x1 + OUT_DOOR.x2) / 2;
  const z = LOBBY.z1 - 0.15;
  const panels = [-1, 1].map(s => {
    const g = new THREE.Group();
    const pane = new THREE.Mesh(new THREE.BoxGeometry(half, 2.5, 0.04), glass);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.5, 0.06), trimMat);
    frame.position.x = s > 0 ? half / 2 : -half / 2;
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 0.08), steelMat);
    handle.position.set(s > 0 ? -half / 2 + 0.12 : half / 2 - 0.12, 0, -0.05);
    g.add(pane, frame, handle);
    g.position.set(mid + s * half / 2, 1.25, z);
    g.userData.closed = g.position.x;
    g.userData.dir = s;
    scene.add(g);
    return g;
  });
  doors.push({
    kind: 'slide', panels, t: 0, center: new THREE.Vector3(mid, 1, z),
    box: new THREE.Box3(new THREE.Vector3(OUT_DOOR.x1, 0, z - 0.1), new THREE.Vector3(OUT_DOOR.x2, 2.5, z + 0.1)),
    slide: half * 0.95, range: 3.2, once: true, msg: ['Welcome to HACA', 'Shoes off at the rack, then use the fingerprint door'],
  });
}
slidingDoor();

// ---------------------------------------------------------------- zones (for HUD + minimap)
const ZONES = [
  { name: 'Lobby', r: [LOBBY.x1, LOBBY.x2, LOBBY.z1, LOBBY.z2], c: '#b48a76' },
  { name: 'Entrance Corridor', r: [-11, -7.4, -6, 1.2], c: '#5b6068' },
  { name: 'Reception', r: [-11, -7.3, 1.2, 5], c: '#c9c2b4' },
  { name: 'Classroom 1', r: [-15, -11, -6, HALL_Z1], c: '#8fb3d9' },
  { name: 'Classroom 2', r: [-19, -15, -6, HALL_Z1], c: '#86aad0' },
  { name: 'Classroom Corridor', r: [-19, -11, HALL_Z1, HALL_Z2], c: '#45494f' },
  { name: 'Classroom Corridor', r: [-12.6, -11, HALL_Z2, 21], c: '#45494f' },
  { name: 'Training Hall', r: [-19, -12.6, HALL_Z2, 9], c: '#9ab9d8' },
  { name: 'Classroom 3', r: [-19, -12.6, 9, 13], c: '#8fb3d9' },
  { name: 'Classroom 4', r: [-19, -12.6, 13, 17], c: '#86aad0' },
  { name: 'Classroom 5', r: [-19, -12.6, 17, 21], c: '#7da1c8' },
  { name: 'Admin Cabin', r: [-11, -7.8, 5, 9], c: '#d9b36c' },
  { name: 'Cabins', r: [-11, -7.8, 9, 21], c: '#cfa863' },
  { name: 'Meeting Room', r: [2, 7.1, 17, 21], c: '#9d8cc4' },
  { name: 'Stepped Seating', r: [-7.3, 7.1, -7.2, -2.3], c: '#c08350' },
  { name: 'Open Workspace', r: [-7.8, 7.1, -3, 21], c: '#d8d2c4' },
];
const ZONE_COUNT = new Set(ZONES.map(z => z.name)).size;
function zoneAt(x, z) {
  for (const zn of ZONES) { const [x1, x2, z1, z2] = zn.r; if (x >= x1 && x < x2 && z >= z1 && z < z2) return zn; }
  return null;
}

// ---------------------------------------------------------------- player avatar (blocky Roblox-style)
const OUTFITS = {
  classic: { skin: 0xf5cd30, shirt: 0x0d69ac, pants: 0x4b974b, hair: 0x4a3222 },
  haca: { skin: 0xffd2b8, shirt: 0x1e9bff, pants: 0x1b1f3a, hair: 0xff3d8f },
  red: { skin: 0xe8b48f, shirt: 0xe53935, pants: 0x263238, hair: 0x1c1c1c },
};
// Mini (chibi) character, about 1 m tall: big head, small body. Sizes in metres.
const PLAYER_R = 0.22, PLAYER_H = 1.08;
const HEAD_Y = 0.78; // head centre

function makeAvatar() {
  const root = new THREE.Group();
  const mats = {
    skin: new THREE.MeshStandardMaterial({ roughness: 0.55 }),
    shirt: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
    pants: new THREE.MeshStandardMaterial({ roughness: 0.7 }),
    hair: new THREE.MeshStandardMaterial({ roughness: 0.45 }),
  };
  const part = (w, h, d, mat, r = 0.035) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
    m.castShadow = true;
    return m;
  };
  // body: hips at 0.24 m, shoulders at 0.52 m
  const torso = part(0.32, 0.3, 0.2, mats.shirt);
  torso.position.y = 0.39;
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.11), new THREE.MeshBasicMaterial({
    transparent: true,
    map: canvasTex(256, 128, (g, w, h) => { g.fillStyle = '#fff'; g.font = 'bold 70px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('HACA', w / 2, h / 2); }),
  }));
  logo.position.set(0, 0.41, 0.1 + 0.003);

  const head = part(0.5, 0.46, 0.46, mats.skin, 0.08);
  head.position.y = HEAD_Y;
  // hair: a cap on top plus a fringe and a few spikes
  const hairCap = part(0.54, 0.14, 0.5, mats.hair, 0.05);
  hairCap.position.set(0, HEAD_Y + 0.2, -0.01);
  const fringe = part(0.52, 0.08, 0.08, mats.hair, 0.03);
  fringe.position.set(0, HEAD_Y + 0.15, 0.21);
  const hairBack = part(0.52, 0.3, 0.08, mats.hair, 0.03);
  hairBack.position.set(0, HEAD_Y + 0.05, -0.22);
  const spikes = [[-0.12, 0.3, 0.05, 0.4], [0.1, 0.31, -0.02, -0.35], [0, 0.33, -0.12, 0]].map(([x, y, z, rz]) => {
    const s = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.16, 4), mats.hair);
    s.position.set(x, HEAD_Y + y, z); s.rotation.z = rz; s.castShadow = true;
    return s;
  });
  // big chibi eyes with shine + small smile
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.3), new THREE.MeshBasicMaterial({
    transparent: true,
    map: canvasTex(256, 192, (g) => {
      for (const x of [78, 178]) {
        g.fillStyle = '#16152b'; g.beginPath(); g.ellipse(x, 86, 24, 34, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(x + 8, 72, 9, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(x - 8, 102, 4, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = 'rgba(255,120,140,.45)';
      g.beginPath(); g.ellipse(40, 140, 20, 10, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(216, 140, 20, 10, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#16152b'; g.lineWidth = 6; g.lineCap = 'round';
      g.beginPath(); g.arc(128, 136, 16, 0.2 * Math.PI, 0.8 * Math.PI); g.stroke();
    }),
  }));
  face.position.set(0, HEAD_Y - 0.04, 0.23 + 0.003);

  const limb = (x, y, w, h, mat) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const m = part(w, h, w + 0.01, mat, 0.03);
    m.position.y = -h / 2 + 0.03;
    pivot.add(m);
    return { pivot, mesh: m };
  };
  const armL = limb(0.215, 0.52, 0.1, 0.22, mats.shirt), armR = limb(-0.215, 0.52, 0.1, 0.22, mats.shirt);
  for (const a of [armL, armR]) { // hands
    const hand = part(0.09, 0.08, 0.1, mats.skin, 0.03);
    hand.position.y = -0.24;
    a.pivot.add(hand);
  }
  const legL = limb(0.08, 0.26, 0.13, 0.29, mats.pants), legR = limb(-0.08, 0.26, 0.13, 0.29, mats.pants);
  legL.mesh.position.y = legR.mesh.position.y = -0.13;

  // name tag
  const tagCanvas = document.createElement('canvas');
  tagCanvas.width = 256; tagCanvas.height = 64;
  const tagTex = new THREE.CanvasTexture(tagCanvas);
  tagTex.colorSpace = THREE.SRGBColorSpace;
  const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tagTex, depthWrite: false }));
  tag.scale.set(1.0, 0.25, 1);
  tag.position.y = 1.35;

  root.add(torso, logo, head, hairCap, fringe, hairBack, ...spikes, face, armL.pivot, armR.pivot, legL.pivot, legR.pivot, tag);
  const avatar = { root, mats, armL: armL.pivot, armR: armR.pivot, legL: legL.pivot, legR: legR.pivot, tag, phase: 0 };
  avatar.setOutfit = (o) => { const f = OUTFITS[o] || OUTFITS.classic; mats.skin.color.setHex(f.skin); mats.shirt.color.setHex(f.shirt); mats.pants.color.setHex(f.pants); mats.hair.color.setHex(f.hair); };
  avatar.setName = (n, talking = false) => {
    avatar.name = n;
    const g = tagCanvas.getContext('2d');
    const text = talking ? '🔊 ' + n : n;
    g.clearRect(0, 0, 256, 64);
    g.font = '600 34px Fredoka, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeText(text, 128, 34);
    g.fillStyle = talking ? '#7dffa1' : '#fff'; g.fillText(text, 128, 34);
    tagTex.needsUpdate = true;
  };
  avatar.setOutfit('classic');
  avatar.setName('Player');
  return avatar;
}

const avatar = makeAvatar();
scene.add(avatar.root);

function animateAvatar(a, dt, speed, onFloor, vy) {
  const k = 1 - Math.exp(-14 * dt);
  let aL, aR, lL, lR;
  if (!onFloor) {
    aL = aR = Math.PI * 0.95 * (vy > -2 ? 1 : 0.75);
    lL = 0.35; lR = -0.2;
  } else if (speed > 0.4) {
    a.phase += dt * (4 + speed * 1.3);
    const amp = Math.min(speed / 5, 1.3) * 0.75;
    const s = Math.sin(a.phase) * amp;
    aL = s; aR = -s; lL = -s; lR = s;
  } else {
    a.phase += dt * 1.5;
    const b = Math.sin(a.phase) * 0.04;
    aL = b; aR = -b; lL = lR = 0;
  }
  a.armL.rotation.x += (-aL - a.armL.rotation.x) * k;
  a.armR.rotation.x += (-aR - a.armR.rotation.x) * k;
  a.legL.rotation.x += (lL - a.legL.rotation.x) * k;
  a.legR.rotation.x += (lR - a.legR.rotation.x) * k;
}

// ---------------------------------------------------------------- load the office
const worldOctree = new Octree();
const fans = [];

// Decorations that should not block the player (floor decals, ceiling fixtures, tiny props).
const NO_COLLIDE = /^(splat|grout|led|light_slit|fan\d|pendant|mesh_|sprinkler|conduit|ac_duct|socket|plant_leaf|hero|chibi|blaster|bucket_\d_(paint|label)|lobby_tile_groove|haca_sign|lobby_sign|reception_sign|vision_board_text|trophy_c\d|floor_trophy_lid|door_mat)|laptop|skirting|_plate$|nosing/;

function addTrianglesFrom(mesh) {
  mesh.updateWorldMatrix(true, false);
  const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index, m = mesh.matrixWorld;
  const n = idx ? idx.count : pos.count;
  for (let i = 0; i < n; i += 3) {
    const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
    worldOctree.addTriangle(new THREE.Triangle(
      new THREE.Vector3().fromBufferAttribute(pos, a).applyMatrix4(m),
      new THREE.Vector3().fromBufferAttribute(pos, b).applyMatrix4(m),
      new THREE.Vector3().fromBufferAttribute(pos, c).applyMatrix4(m)));
  }
}

function namesOf(o, stop) {
  const out = [];
  for (let n = o; n && n !== stop; n = n.parent) if (n.name) out.push(n.name);
  return out;
}

const loadText = document.getElementById('loadText');
const barFill = document.getElementById('barFill');
const playBtn = document.getElementById('playBtn');

new GLTFLoader().load('paint-hide-seek-office.glb', (gltf) => {
  loadText.textContent = 'Building the world…';
  setTimeout(() => setupOffice(gltf.scene), 30);
}, (e) => {
  const p = e.total ? Math.round(e.loaded / e.total * 100) : Math.min(99, Math.round(e.loaded / 67400));
  barFill.style.width = p + '%';
  loadText.textContent = `Loading building… ${p}%`;
}, (err) => {
  console.error(err);
  loadText.innerHTML = 'Could not load the 3D model.<br>Open the game with <b>start-game.bat</b> (it needs a local web server).';
});

function setupOffice(office) {
  // Mirror the model in x so its handedness matches the real office (see the layout notes above).
  const root = new THREE.Group();
  scene.add(root);
  root.add(office);
  office.scale.x = -1;
  root.updateMatrixWorld(true);

  const get = (n) => root.getObjectByName(n); // moved parts live directly under root
  const meshesOf = (o) => { const a = []; o.traverse(c => { if (c.isMesh) a.push(c); }); return a; };
  const named = (re) => { const a = []; root.traverse(o => { if (o.name && re.test(o.name) && !(o.parent && re.test(o.parent.name))) a.push(o); }); return a; };
  const hide = (re) => named(re).forEach(o => { o.visible = false; });
  const dynamic = new Set();

  // Move a set of model parts: rotate about their centre, then align their bounding box.
  const place = (objs, rotY, t) => {
    if (!objs.length) return;
    const bb = new THREE.Box3(); objs.forEach(o => bb.expandByObject(o));
    const c = bb.getCenter(new THREE.Vector3());
    const m = new THREE.Matrix4().makeTranslation(c.x, 0, c.z)
      .multiply(new THREE.Matrix4().makeRotationY(rotY))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, 0, -c.z));
    objs.forEach(o => { root.attach(o); o.applyMatrix4(m); o.updateMatrixWorld(true); });
    const b2 = new THREE.Box3(); objs.forEach(o => b2.expandByObject(o));
    let dx = 0, dz = 0;
    if (t.cx !== undefined) dx = t.cx - (b2.min.x + b2.max.x) / 2;
    if (t.minX !== undefined) dx = t.minX - b2.min.x;
    if (t.maxX !== undefined) dx = t.maxX - b2.max.x;
    if (t.cz !== undefined) dz = t.cz - (b2.min.z + b2.max.z) / 2;
    if (t.minZ !== undefined) dz = t.minZ - b2.min.z;
    if (t.maxZ !== undefined) dz = t.maxZ - b2.max.z;
    const tr = new THREE.Matrix4().makeTranslation(dx, 0, dz);
    objs.forEach(o => { o.applyMatrix4(tr); o.updateMatrixWorld(true); });
  };

  // parts of the model's south wing that the rebuilt layout replaces
  hide(/^(east_wall_south|lobby_north_wall|lobby_granite|lobby_granite_band|haca_wall|vision_board|trophy_wall_[ab]|reception_frame_[vh]\d?|metal_shoe_rack)$/);

  // lobby: black tile wall + "Haris&Co." sign + fingerprint scanner left of the office door
  place(named(/^(lobby_black_tile_wall|lobby_tile_groove\d|lobby_sign|fingerprint_scanner)$/), 0, { cx: -8.75, maxZ: -6.07 });
  place(named(/^(entry_header|entry_wood_jamb\d|entry_wood_head|entry_glass_door)$/), 0, { cx: (OFFICE_DOOR.x1 + OFFICE_DOOR.x2) / 2, cz: OFFICE_DOOR.z });
  place(named(/^door_mat$/), 0, { cx: (OFFICE_DOOR.x1 + OFFICE_DOOR.x2) / 2, maxZ: -6.1 });
  place(named(/^shoe_cabinet\d$/), -Math.PI / 2, { cx: -12.9, maxZ: -6.07 });     // right of the door
  place(named(/^staircase$/), Math.PI / 2, { minX: LOBBY.x1 + 0.08, cz: -9.6 });   // west side, going up
  // trophies line the right-hand corridor wall, after the classroom opening
  place(named(/^(trophy_c\d|trophy_col\d|floor_trophy)/), Math.PI / 2, { minX: -10.93, cz: 1.25 });
  // reception sits at the end of the corridor, against the admin cabin wall
  place(named(/^(reception_(black_block|desk|ledge|plate|chair\d|sign)|pendant\d_(cord|shade|bulb))$/), 0, { cx: -9.47, maxZ: 4.93 }); // desk butts the wall: no gap to get trapped in
  place(named(/^reception_column$/), 0, { cx: -7.55, cz: 4.62 });
  place(named(/^plant$/), 0, { cx: -8.25, cz: 4.5 });
  // lounge sofa on the left as you reach reception; HACA sign + paint on the corridor's white wall
  place(named(/^sofa$/), Math.PI, { minX: -7.3, cz: -0.6 });
  place(named(/^(haca_sign|splat_haca_lime_(core|drop\d))$/), 0, { maxX: -7.47, cz: -3.2 });

  // Some walls in the model are solid where the real office has doorways (the doors are only
  // drawn on). Replace them with the same wall split around walkable gaps along z.
  const cutGaps = (name, gaps, headerFrom) => {
    const o = get(name);
    if (!o) return;
    const mesh = meshesOf(o)[0];
    const b = new THREE.Box3().setFromObject(o);
    o.visible = false;
    const opts = { cast: !mesh.material.transparent };
    let z = b.min.z;
    for (const [g1, g2] of gaps) {
      if (g1 > z) box(b.min.x, b.max.x, b.min.y, b.max.y, z, g1, mesh.material, opts);
      if (headerFrom !== undefined) box(b.min.x, b.max.x, headerFrom, b.max.y, g1, g2, mesh.material, opts);
      z = g2;
    }
    if (b.max.z > z) box(b.min.x, b.max.x, b.min.y, b.max.y, z, b.max.z, mesh.material, opts);
  };
  cutGaps('corridor_south_wall', [[10.03, 10.97], [14.03, 14.97], [18.03, 18.97]], 2.15);
  for (let i = 0; i < 4; i++) { // glass cabins get an open doorway on the office side
    const z0 = 18 - i * 3;
    cutGaps(`cabin${i}_frost`, [[z0 + 0.03, z0 + 0.97]]); // between the first two mullions
    cutGaps(`cabin${i}_base`, [[z0 + 0.03, z0 + 0.97]]);
  }
  cutGaps('room_glass_s', [[18.03, 18.97]]); // meeting room doorway
  cutGaps('room_frost_s', [[18.03, 18.97]]);
  // the classroom whiteboards hang across the doorways; shrink them to the wall beside the door
  for (let i = 0; i < 3; i++) {
    const b = get(`class${i}_board`);
    if (!b) continue;
    const bb = new THREE.Box3().setFromObject(b);
    const z1 = bb.min.z + 1.15, z2 = bb.max.z - 0.15;
    const oc = (bb.min.z + bb.max.z) / 2, k = (z2 - z1) / (bb.max.z - bb.min.z);
    b.applyMatrix4(new THREE.Matrix4().makeTranslation(0, 0, (z1 + z2) / 2)
      .multiply(new THREE.Matrix4().makeScale(1, 1, k))
      .multiply(new THREE.Matrix4().makeTranslation(0, 0, -oc)));
  }
  root.updateMatrixWorld(true);

  // classroom doors (hinge at the low-z edge, open west into the classroom)
  for (const id of ['C4', 'C5', 'C6']) {
    const parts = [get('door_' + id), get(`door_${id}_glass`), get(`door_${id}_plate`)].filter(Boolean);
    if (!parts.length) continue;
    const bb = new THREE.Box3(); parts.forEach(p => bb.expandByObject(p));
    parts.forEach(p => meshesOf(p).forEach(m => dynamic.add(m)));
    hingeDoor(parts, new THREE.Vector3((bb.min.x + bb.max.x) / 2, 0, bb.min.z), -1.45);
  }
  // admin cabin door
  {
    const d = get('admin_door');
    if (d) {
      const bb = new THREE.Box3().setFromObject(d);
      meshesOf(d).forEach(m => dynamic.add(m));
      hingeDoor([d], new THREE.Vector3((bb.min.x + bb.max.x) / 2, 0, bb.min.z), -1.45);
    }
  }
  // fingerprint glass door between the lobby and the entrance corridor
  {
    const d = get('entry_glass_door');
    if (d) {
      const bb = new THREE.Box3().setFromObject(d);
      meshesOf(d).forEach(m => dynamic.add(m));
      hingeDoor([d], new THREE.Vector3(bb.min.x, 0, (bb.min.z + bb.max.z) / 2), -1.5,
        { msg: ['Fingerprint verified ✔', 'Door unlocked'], beep: true });
    }
  }
  // ceiling fans spin
  for (let i = 0; i < 20; i++) {
    const motor = get(`fan${i}_motor`);
    if (!motor) continue;
    const c = new THREE.Box3().setFromObject(motor).getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.position.copy(c);
    scene.add(pivot);
    const parts = [motor];
    for (let b = 0; b < 6; b++) { const bl = get(`fan${i}_blade${b}`); if (bl) parts.push(bl); }
    parts.forEach(p => { meshesOf(p).forEach(m => dynamic.add(m)); pivot.attach(p); });
    pivot.userData.speed = 5 + (i % 3);
    fans.push(pivot);
  }

  // Merge every static mesh by material: ~2000 draw calls -> ~50.
  const byMat = new Map();
  const shown = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };
  root.traverse((o) => {
    if (!o.isMesh || dynamic.has(o) || !shown(o)) return;
    const names = namesOf(o, root);
    if (!names.some(n => NO_COLLIDE.test(n))) addTrianglesFrom(o);
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (o.matrixWorld.determinant() < 0) {
      // a mirrored transform flips the winding order; swap two corners of every triangle back
      for (const attr of Object.values(g.attributes)) {
        const a = attr.array, n = attr.itemSize;
        for (let t = 0; t < attr.count; t += 3) for (let k = 0; k < n; k++) {
          const i1 = (t + 1) * n + k, i2 = (t + 2) * n + k;
          const tmp = a[i1]; a[i1] = a[i2]; a[i2] = tmp;
        }
      }
      // keep sign text readable
      if (o.material.map && g.attributes.uv) { const uv = g.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i)); }
    }
    if (!byMat.has(o.material)) byMat.set(o.material, []);
    byMat.get(o.material).push(g);
  });
  const staticGroup = new THREE.Group();
  for (const [mat, geos] of byMat) {
    const allUV = geos.every(g => g.attributes.uv);
    if (!allUV) geos.forEach(g => g.deleteAttribute('uv'));
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    // some slabs in the model are one-sided or have flipped triangles; render both faces
    if (/floor|ceiling|wall/.test(mat.name)) mat.side = THREE.DoubleSide;
    if (mat.transparent) { mat.depthWrite = false; mesh.castShadow = false; } else mesh.castShadow = true;
    mesh.receiveShadow = true;
    staticGroup.add(mesh);
  }
  scene.remove(root);
  scene.add(staticGroup);
  if (params.has('noroof')) {
    roofMat.visible = false;
    staticGroup.traverse(m => { if (m.isMesh && /ceiling|mesh_ceiling/.test(m.material.name)) m.visible = false; });
  }

  for (const m of collidables) addTrianglesFrom(m);
  worldOctree.build();

  // the doors' moved meshes still cast shadows; mirrored door meshes need both faces drawn
  doors.forEach(d => d.pivot && d.pivot.traverse(m => { if (m.isMesh) { m.castShadow = !m.material.transparent; m.receiveShadow = true; } }));

  ready();
}

// ---------------------------------------------------------------- player physics
const player = {
  collider: new Capsule(new THREE.Vector3(), new THREE.Vector3(), PLAYER_R),
  vel: new THREE.Vector3(),
  onFloor: false,
  airTime: 0,
  facing: SPAWN_YAW + Math.PI,
  visualY: 0,
};
const GRAVITY = 26, JUMP_V = 8.2, WALK = 5.2, RUN = 8.5, STEP_H = 0.3;

function placePlayer(x, z, yaw) {
  const y = 0.12;
  player.collider.start.set(x, y + PLAYER_R, z);
  player.collider.end.set(x, y + PLAYER_H - PLAYER_R, z);
  player.vel.set(0, 0, 0);
  player.visualY = y;
  if (yaw !== undefined) { cam.yaw = yaw; player.facing = yaw + Math.PI; }
}

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

function pushOutOfBox(b) {
  const c = player.collider;
  if (c.end.y + PLAYER_R < b.min.y || c.start.y - PLAYER_R > b.max.y) return;
  const px = c.start.x, pz = c.start.z;
  const cx = THREE.MathUtils.clamp(px, b.min.x, b.max.x), cz = THREE.MathUtils.clamp(pz, b.min.z, b.max.z);
  let dx = px - cx, dz = pz - cz;
  const d = Math.hypot(dx, dz);
  if (d >= PLAYER_R) return;
  if (d < 1e-5) { // centre inside the box: leave along the thinnest side
    const opts = [[b.min.x - PLAYER_R - px, 0], [b.max.x + PLAYER_R - px, 0], [0, b.min.z - PLAYER_R - pz], [0, b.max.z + PLAYER_R - pz]];
    opts.sort((a, b2) => Math.abs(a[0] + a[1]) - Math.abs(b2[0] + b2[1]));
    c.translate(_v.set(opts[0][0], 0, opts[0][1]));
    return;
  }
  const push = PLAYER_R - d;
  c.translate(_v.set(dx / d * push, 0, dz / d * push));
  const dot = (player.vel.x * dx + player.vel.z * dz) / d;
  if (dot < 0) { player.vel.x -= dx / d * dot; player.vel.z -= dz / d * dot; }
}

function collide(moveDir) {
  const wasOnFloor = player.onFloor;
  player.onFloor = false;
  const c = player.collider;
  let res = worldOctree.capsuleIntersect(c);
  if (res && (res.depth < 1e-6 || !Number.isFinite(res.normal.y))) res = false; // touching only
  if (res) {
    // step up onto small ledges (stairs, low platforms)
    if (wasOnFloor && Math.abs(res.normal.y) < 0.4 && moveDir.lengthSq() > 0.01) {
      const test = c.clone();
      test.translate(_v2.set(moveDir.x * 0.06, STEP_H, moveDir.z * 0.06));
      if (!worldOctree.capsuleIntersect(test)) { c.copy(test); player.onFloor = true; player.vel.y = 0; return; }
    }
    player.onFloor = res.normal.y > 0.3;
    if (!player.onFloor) player.vel.addScaledVector(res.normal, -res.normal.dot(player.vel));
    else if (player.vel.y < 0) player.vel.y = 0;
    c.translate(res.normal.multiplyScalar(res.depth));
  }
  // ground plane outside the building
  const feet = c.start.y - PLAYER_R;
  if (feet < 0) { c.translate(_v.set(0, -feet, 0)); player.onFloor = true; if (player.vel.y < 0) player.vel.y = 0; }
  // closed doors still block
  for (const d of doors) if (d.t < 0.55) pushOutOfBox(d.box);
  // world bounds
  const bx = THREE.MathUtils.clamp(c.start.x, -70, 100) - c.start.x, bz = THREE.MathUtils.clamp(c.start.z, -70, 80) - c.start.z;
  if (bx || bz) c.translate(_v.set(bx, 0, bz));
}

const keys = {};
let dbgInfo = '';
const touchMove = new THREE.Vector2();
let jumpQueued = false;

function updatePlayer(dt) {
  // input direction relative to the camera
  let ix = (keys.KeyD || keys.ArrowRight ? 1 : 0) - (keys.KeyA || keys.ArrowLeft ? 1 : 0) + touchMove.x;
  let iz = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0) + touchMove.y;
  const len = Math.hypot(ix, iz);
  if (len > 1) { ix /= len; iz /= len; }
  const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
  const rx = -fz, rz = fx;
  const dir = _v2.set(fx * iz + rx * ix, 0, fz * iz + rz * ix);
  const moveDir = dir.clone();
  const speed = (keys.ShiftLeft || keys.ShiftRight || len > 0.95 && isTouch) ? RUN : WALK;

  const accel = player.onFloor ? 14 : 4;
  const k = 1 - Math.exp(-accel * dt);
  player.vel.x += (dir.x * speed - player.vel.x) * k;
  player.vel.z += (dir.z * speed - player.vel.z) * k;
  // gravity always applies so the capsule keeps touching the floor (no on/off flicker)
  player.vel.y -= GRAVITY * dt;
  if (player.onFloor && (jumpQueued || keys.Space)) { player.vel.y = JUMP_V; player.onFloor = false; player.airTime = 1; }
  jumpQueued = false;

  player.collider.translate(_v.copy(player.vel).multiplyScalar(dt));
  collide(moveDir);
  player.airTime = player.onFloor ? 0 : player.airTime + dt;

  if (moveDir.lengthSq() > 0.01) {
    const target = Math.atan2(moveDir.x, moveDir.z);
    let diff = target - player.facing;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    player.facing += diff * Math.min(1, dt * 14);
  }
  if (player.collider.start.y < -25) respawn();
}

function respawn() { placePlayer(SPAWN.x, SPAWN.z, SPAWN_YAW); }

// ---------------------------------------------------------------- camera
const cam = { yaw: SPAWN_YAW, pitch: 0.28, dist: 5, cur: 5 };
const camRay = new THREE.Ray();

function updateCamera(dt) {
  const target = _v.set(player.collider.start.x, player.visualY + 0.95, player.collider.start.z);
  const cp = Math.cos(cam.pitch);
  const dir = _v2.set(Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), Math.cos(cam.yaw) * cp);
  let max = cam.dist;
  if (cam.dist > 0.6) {
    camRay.set(target, dir);
    const hit = worldOctree.rayIntersect(camRay);
    if (hit && hit.distance < max + 0.3) max = Math.max(0.3, hit.distance - 0.3);
  }
  cam.cur = max < cam.cur ? max : cam.cur + (max - cam.cur) * Math.min(1, dt * 6);
  const firstPerson = cam.cur < 0.7;
  avatar.root.visible = !firstPerson;
  if (firstPerson) {
    camera.position.copy(target).y += 0.1;
    camera.lookAt(target.x - dir.x, target.y + 0.1 - dir.y, target.z - dir.z);
  } else {
    camera.position.copy(target).addScaledVector(dir, cam.cur);
    camera.lookAt(target);
  }
}

// ---------------------------------------------------------------- doors + fans
let audioCtx;
function beep(freqs) {
  try {
    audioCtx ||= new AudioContext();
    let t = audioCtx.currentTime;
    for (const f of freqs) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.15, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.15);
      t += 0.12;
    }
  } catch { /* audio not available */ }
}

function updateDoors(dt) {
  const who = [player.collider.start, ...net.positions()];
  for (const d of doors) {
    const near = who.some(p => Math.hypot(p.x - d.center.x, p.z - d.center.z) < (d.range || 2.1));
    const was = d.t;
    d.t = THREE.MathUtils.clamp(d.t + (near ? 3 : -1.5) * dt, 0, 1);
    if (was === 0 && d.t > 0) {
      if (d.beep) beep([1320, 1760]); else if (d.kind === 'slide') beep([660, 880]);
      if (d.msg && !(d.once && d.shown)) { toast(d.msg[0], d.msg[1]); d.shown = true; }
    }
    const e = d.t * d.t * (3 - 2 * d.t);
    if (d.kind === 'hinge') d.pivot.rotation.y = d.openAngle * e;
    else for (const p of d.panels) p.position.x = p.userData.closed + p.userData.dir * d.slide * e;
  }
  for (const f of fans) f.rotation.y += f.userData.speed * dt;
}

// ---------------------------------------------------------------- HUD
const hud = document.getElementById('hud');
const zoneEl = document.getElementById('zone');
const toastEl = document.getElementById('toast');
const exploredEl = document.getElementById('explored');
const mapCanvas = document.getElementById('map');
const mapCtx = mapCanvas.getContext('2d');
const visited = new Set();
let currentZone = 'start', toastTimer;

function toast(title, sub = '') {
  toastEl.innerHTML = title + (sub ? `<small>${sub}</small>` : '');
  toastEl.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.style.opacity = 0, 2600);
}

function updateZone() {
  const zn = zoneAt(player.collider.start.x, player.collider.start.z);
  const name = zn ? zn.name : 'Outside';
  if (name === currentZone) return;
  currentZone = name;
  zoneEl.textContent = '📍 ' + name;
  if (zn && !visited.has(name)) {
    visited.add(name);
    toast(name, visited.size === ZONE_COUNT ? '🎉 You explored the whole office!' : `New area discovered (${visited.size}/${ZONE_COUNT})`);
  }
  exploredEl.textContent = `Explored: ${visited.size} / ${ZONE_COUNT}`;
}

// minimap: top view with north (+z) up; seen from above, -x is on the right
const MAP = { x0: -20.5, x1: 8.5, z0: -16, z1: 22.5 };
function drawMap() {
  const W = mapCanvas.width, H = mapCanvas.height;
  const s = Math.min(W / (MAP.x1 - MAP.x0), H / (MAP.z1 - MAP.z0));
  const ox = (W - (MAP.x1 - MAP.x0) * s) / 2, oz = (H - (MAP.z1 - MAP.z0) * s) / 2;
  const tx = (x) => ox + (MAP.x1 - x) * s, tz = (z) => oz + (MAP.z1 - z) * s;
  const rect = (x1, x2, z1, z2) => [tx(x2), tz(z2), (x2 - x1) * s, (z2 - z1) * s];
  const g = mapCtx;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#4c7d35'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#c9c4ba'; g.fillRect(...rect(-22, 2, -36, -12));
  for (let i = ZONES.length - 1; i >= 0; i--) {
    const zn = ZONES[i];
    g.globalAlpha = visited.has(zn.name) ? 1 : 0.45;
    g.fillStyle = zn.c;
    g.fillRect(...rect(...zn.r));
  }
  g.globalAlpha = 1;
  g.strokeStyle = '#1b1d22'; g.lineWidth = 3;
  g.strokeRect(...rect(-7.3, 7.25, -7.2, 21));
  g.strokeRect(...rect(-19, -7.3, -6, 21));
  g.strokeRect(...rect(LOBBY.x1, LOBBY.x2, LOBBY.z1, LOBBY.z2));
  g.fillStyle = '#4ee08a';
  g.fillRect(...rect(OUT_DOOR.x1, OUT_DOOR.x2, LOBBY.z1 - 0.3, LOBBY.z1 + 0.3));
  g.fillRect(...rect(OFFICE_DOOR.x1, OFFICE_DOOR.x2, OFFICE_DOOR.z - 0.3, OFFICE_DOOR.z + 0.3));
  // player arrow (clamped to the map edge when outside it)
  const px = THREE.MathUtils.clamp(tx(player.collider.start.x), 8, W - 8), pz = THREE.MathUtils.clamp(tz(player.collider.start.z), 8, H - 8);
  g.save();
  g.translate(px, pz);
  g.rotate(-player.facing);
  g.fillStyle = '#ff3b3b'; g.strokeStyle = '#fff'; g.lineWidth = 2;
  g.beginPath(); g.moveTo(0, -11); g.lineTo(8, 8); g.lineTo(0, 4); g.lineTo(-8, 8); g.closePath(); g.fill(); g.stroke();
  g.restore();
}

// ---------------------------------------------------------------- multiplayer + proximity voice
// Players connect to server.js over a WebSocket; it relays positions and WebRTC signalling.
// Voice goes peer-to-peer (WebRTC). Each remote voice is panned and faded by distance.
const net = (() => {
  const remotes = new Map(); // id -> { avatar, name, target, facing, s, pc, tr, audio, gain, pan, analyser, talking, pendingIce }
  const onlineEl = document.getElementById('online');
  const micBtn = document.getElementById('micBtn');
  const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
  let ws = null, sendTimer = 0, micTrack = null, micOn = false, actx = null, myAnalyser = null, myTalking = false;
  const level = new Uint8Array(256);

  const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const updateCount = () => {
    if (!onlineEl) return;
    onlineEl.textContent = ws && ws.readyState === 1 ? `👥 ${remotes.size + 1} online` : '👤 Offline (single player)';
    onlineEl.title = ['You', ...[...remotes.values()].map(r => r.name)].join('\n');
  };
  const speaking = (an) => {
    an.getByteTimeDomainData(level);
    let peak = 0;
    for (const v of level) peak = Math.max(peak, Math.abs(v - 128));
    return peak > 12;
  };

  function applyState(r, s) {
    r.s = s;
    r.target.set(s[0], s[1], s[2]);
    r.facing = s[3];
    r.avatar.root.visible = true;
  }
  function addRemote(id, name, outfit, s) {
    if (remotes.has(id)) return remotes.get(id);
    const a = makeAvatar();
    a.setOutfit(outfit);
    a.setName(name);
    scene.add(a.root);
    const r = { avatar: a, name, target: new THREE.Vector3(), facing: 0, s: [0, 0, 0, 0, 0, 1, 0], pc: null, tr: null, pendingIce: [], talking: false };
    if (s) { applyState(r, s); a.root.position.copy(r.target); a.root.rotation.y = r.facing; }
    else a.root.visible = false; // until the first position arrives
    remotes.set(id, r);
    updateCount();
    return r;
  }
  function removeRemote(id) {
    const r = remotes.get(id);
    if (!r) return;
    scene.remove(r.avatar.root);
    if (r.pc) r.pc.close();
    if (r.audio) r.audio.srcObject = null;
    remotes.delete(id);
    updateCount();
  }

  // ---- voice
  function audioCtx() {
    if (!actx) actx = new AudioContext();
    if (actx.state === 'suspended') actx.resume();
    return actx;
  }
  function peer(id, initiator) {
    const r = remotes.get(id) || addRemote(id, 'Player', 'classic');
    if (r.pc) return r;
    const pc = new RTCPeerConnection(ICE);
    r.pc = pc;
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: 'signal', to: id, data: { ice: e.candidate } }); };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      // Chrome only feeds remote WebRTC audio into Web Audio while a media element plays it
      r.audio = new Audio(); r.audio.srcObject = stream; r.audio.muted = true; r.audio.play().catch(() => {});
      const c = audioCtx();
      const src = c.createMediaStreamSource(stream);
      r.gain = c.createGain(); r.pan = c.createStereoPanner(); r.analyser = c.createAnalyser();
      r.analyser.fftSize = 256;
      src.connect(r.analyser);
      src.connect(r.gain).connect(r.pan).connect(c.destination);
    };
    if (initiator) {
      r.tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
      if (micTrack) r.tr.sender.replaceTrack(micTrack);
      pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => send({ type: 'signal', to: id, data: { sdp: pc.localDescription } }));
    }
    return r;
  }
  async function onSignal(from, data) {
    const r = peer(from, false);
    const pc = r.pc;
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp);
        if (data.sdp.type === 'offer') {
          r.tr = pc.getTransceivers()[0];
          r.tr.direction = 'sendrecv';
          if (micTrack) await r.tr.sender.replaceTrack(micTrack);
          await pc.setLocalDescription(await pc.createAnswer());
          send({ type: 'signal', to: from, data: { sdp: pc.localDescription } });
        }
        for (const c of r.pendingIce.splice(0)) await pc.addIceCandidate(c);
      } else if (data.ice) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.ice); else r.pendingIce.push(data.ice);
      }
    } catch (err) { console.warn('voice signalling', err); }
  }
  async function toggleMic() {
    if (!micTrack) {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        // browsers only allow the mic on https:// (or localhost): offer the server's secure address
        const cfg = await fetch('/config.json').then(r => r.json()).catch(() => ({}));
        if (cfg.httpsPort) {
          const url = `https://${location.hostname}:${cfg.httpsPort}${location.pathname}`;
          if (document.pointerLockElement) document.exitPointerLock();
          if (confirm(`Voice chat needs the secure address:\n${url}\n\nSwitch now? (If the browser shows a security warning, click "Advanced" → "Proceed".)`)) location.href = url;
        } else {
          toast('Voice chat unavailable', 'The mic needs https:// or localhost');
        }
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        micTrack = stream.getAudioTracks()[0];
        const c = audioCtx();
        myAnalyser = c.createAnalyser(); myAnalyser.fftSize = 256;
        c.createMediaStreamSource(stream).connect(myAnalyser);
        for (const r of remotes.values()) if (r.tr) r.tr.sender.replaceTrack(micTrack);
      } catch { toast('Microphone blocked', 'Allow mic access in the browser to talk'); return; }
      micOn = true;
    } else {
      micOn = !micOn;
    }
    micTrack.enabled = micOn;
    if (micBtn) { micBtn.textContent = micOn ? '🎤 Mic on (V)' : '🔇 Mic off (V)'; micBtn.classList.toggle('on', micOn); }
    toast(micOn ? '🎤 Mic on' : '🔇 Mic off', micOn ? 'Players near you can hear you' : '');
  }
  if (micBtn) micBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMic(); });

  function connect(name, outfit) {
    if (ws || location.protocol === 'file:') { updateCount(); return; }
    audioCtx();
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); } catch { ws = null; updateCount(); return; }
    ws.onopen = () => { send({ type: 'join', name, outfit }); updateCount(); };
    ws.onclose = () => { for (const id of [...remotes.keys()]) removeRemote(id); updateCount(); };
    ws.onerror = () => updateCount();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === 'welcome') {
        for (const p of m.players) { addRemote(p.id, p.name, p.outfit, p.state); peer(p.id, true); }
        updateCount();
        if (m.players.length) toast(`👥 ${m.players.length + 1} players online`, 'Press V to talk (proximity voice)');
      } else if (m.type === 'joined') {
        addRemote(m.id, m.name, m.outfit);
        toast(`${m.name} joined`, 'Press V to talk');
      } else if (m.type === 'left') {
        const r = remotes.get(m.id);
        if (r) toast(`${r.name} left`);
        removeRemote(m.id);
      } else if (m.type === 'state') {
        const r = remotes.get(m.id);
        if (r) applyState(r, m.s);
      } else if (m.type === 'signal') {
        onSignal(m.from, m.data);
      }
    };
    updateCount();
  }

  const _d = new THREE.Vector3();
  function update(dt) {
    // send my state ~15 times a second
    sendTimer -= dt;
    if (sendTimer <= 0 && started) {
      sendTimer = 1 / 15;
      const c = player.collider.start;
      send({ type: 'state', s: [+c.x.toFixed(2), +player.visualY.toFixed(2), +c.z.toFixed(2), +player.facing.toFixed(2),
        +Math.hypot(player.vel.x, player.vel.z).toFixed(1), player.airTime < 0.12 ? 1 : 0, +player.vel.y.toFixed(1)] });
    }
    const k = 1 - Math.exp(-12 * dt);
    const camYaw = Math.atan2(camera.position.x - player.collider.start.x, camera.position.z - player.collider.start.z);
    for (const r of remotes.values()) {
      const a = r.avatar;
      a.root.position.lerp(r.target, k);
      let diff = r.facing - a.root.rotation.y;
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      a.root.rotation.y += diff * k;
      animateAvatar(a, dt, r.s[4], r.s[5] === 1, r.s[6]);
      if (r.gain) { // proximity voice: full volume within 2 m, silent past 22 m, panned left/right
        const d = _d.copy(a.root.position).sub(player.collider.start);
        const dist = Math.hypot(d.x, d.z);
        r.gain.gain.value = THREE.MathUtils.clamp(1 - (dist - 2) / 20, 0, 1);
        const ang = Math.atan2(d.x, d.z) - camYaw;
        r.pan.pan.value = dist < 0.5 ? 0 : -Math.sin(ang) * 0.8;
        const t = speaking(r.analyser) && r.gain.gain.value > 0.01;
        if (t !== r.talking) { r.talking = t; a.setName(r.name, t); }
      }
    }
    if (myAnalyser) {
      const t = micOn && speaking(myAnalyser);
      if (t !== myTalking) { myTalking = t; avatar.setName(avatar.name, t); }
    }
  }

  return { connect, update, toggleMic, positions: () => [...remotes.values()].filter(r => r.avatar.root.visible).map(r => r.avatar.root.position) };
})();

// ---------------------------------------------------------------- input
const menu = document.getElementById('menu');
const pauseEl = document.getElementById('pause');
let playing = false, started = false, outfit = 'classic';

document.querySelectorAll('.outfit').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.outfit').forEach(x => x.classList.remove('sel'));
  b.classList.add('sel');
  outfit = b.dataset.o;
  avatar.setOutfit(outfit);
}));

function lockPointer() { if (!isTouch && canvas.requestPointerLock) canvas.requestPointerLock(); }

playBtn.addEventListener('click', () => {
  avatar.setName(document.getElementById('name').value.trim() || 'Player');
  avatar.setOutfit(outfit);
  menu.classList.add('hidden');
  hud.classList.remove('hidden');
  if (isTouch) document.getElementById('touch').classList.remove('hidden');
  playing = started = true;
  respawn();
  lockPointer();
  toast('You spawned outside', 'Walk to the HACA entrance ➜');
  net.connect(avatar.name, outfit);
});
document.getElementById('resumeBtn').addEventListener('click', () => { pauseEl.classList.add('hidden'); playing = true; lockPointer(); });
canvas.addEventListener('click', () => { if (playing && document.pointerLockElement !== canvas) lockPointer(); });
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas && playing && !isTouch) { playing = false; pauseEl.classList.remove('hidden'); }
});

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (e.code === 'Space') { jumpQueued = true; e.preventDefault(); }
  if (e.code === 'KeyR' && playing) respawn();
  if (e.code === 'KeyV' && started) net.toggleMic();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  cam.yaw -= e.movementX * 0.0024;
  cam.pitch = THREE.MathUtils.clamp(cam.pitch + e.movementY * 0.0024, -0.75, 1.35);
});
addEventListener('wheel', (e) => {
  cam.dist = THREE.MathUtils.clamp(cam.dist + Math.sign(e.deltaY) * 0.8, 0.4, 16);
}, { passive: true });

// touch: left stick to move, drag anywhere else to look
{
  const stick = document.getElementById('stick'), knob = document.getElementById('knob');
  let stickId = null, lookId = null, lx = 0, ly = 0, pinch = null;
  const rect = () => stick.getBoundingClientRect();
  stick.addEventListener('touchstart', (e) => { stickId = e.changedTouches[0].identifier; e.preventDefault(); }, { passive: false });
  document.getElementById('jumpBtn').addEventListener('touchstart', (e) => { jumpQueued = true; e.preventDefault(); }, { passive: false });
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); return; }
    const t = e.changedTouches[0]; lookId = t.identifier; lx = t.clientX; ly = t.clientY;
  }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (pinch !== null && e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      cam.dist = THREE.MathUtils.clamp(cam.dist - (d - pinch) * 0.03, 0.4, 16); pinch = d; return;
    }
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) {
        const r = rect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        let dx = (t.clientX - cx) / (r.width / 2), dy = (t.clientY - cy) / (r.height / 2);
        const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
        touchMove.set(dx, -dy);
        knob.style.transform = `translate(${dx * 40}px, ${dy * 40}px)`;
      } else if (t.identifier === lookId) {
        cam.yaw -= (t.clientX - lx) * 0.006;
        cam.pitch = THREE.MathUtils.clamp(cam.pitch + (t.clientY - ly) * 0.006, -0.75, 1.35);
        lx = t.clientX; ly = t.clientY;
      }
    }
  }, { passive: true });
  addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinch = null;
    for (const t of e.changedTouches) {
      if (t.identifier === stickId) { stickId = null; touchMove.set(0, 0); knob.style.transform = ''; }
      if (t.identifier === lookId) lookId = null;
    }
  });
}

// ---------------------------------------------------------------- main loop
function ready() {
  barFill.style.width = '100%';
  loadText.textContent = 'Ready!';
  playBtn.disabled = false;
  playBtn.textContent = '▶ Play';
  respawn();
  exploredEl.textContent = `Explored: 0 / ${ZONE_COUNT}`;

  // debug helpers for screenshots: ?auto&p=x,z,yaw&cam=x,y,z,tx,ty,tz
  if (params.has('auto')) playBtn.click();
  if (params.get('p')) { const [x, z, yaw] = params.get('p').split(',').map(Number); placePlayer(x, z, yaw); }
  if (params.get('pitch')) cam.pitch = +params.get('pitch');
  if (params.get('dist')) cam.dist = cam.cur = +params.get('dist');
  for (const k of params.get('hold')?.split(',') || []) keys[k] = true;
  if (params.has('mic')) net.toggleMic();
  // debug: run a scripted walk at a fixed 60 Hz before the first frame, e.g. sim=y1.57,W3,y3.14,W2
  if (params.get('sim')) {
    const trail = [];
    for (const step of params.get('sim').split(',')) {
      const v = parseFloat(step.slice(1));
      if (step[0] === 'y') { cam.yaw = v; continue; }
      const code = { W: 'KeyW', A: 'KeyA', S: 'KeyS', D: 'KeyD', J: 'Space' }[step[0]];
      keys[code] = true;
      for (let i = 0; i < v * 60; i++) { for (let s = 0; s < 4; s++) updatePlayer(1 / 240); updateDoors(1 / 60); updateZone(); }
      keys[code] = false;
      const c = player.collider.start;
      trail.push(`${step}->(${c.x.toFixed(1)},${(c.y - PLAYER_R).toFixed(2)},${c.z.toFixed(1)})`);
    }
    dbgInfo = trail.join(' ');
  }

  const clock = new THREE.Clock();
  const fixedCam = params.get('cam')?.split(',').map(Number);
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (playing || params.has('auto')) {
      const steps = 4;
      for (let i = 0; i < steps; i++) updatePlayer(dt / steps);
      updateZone();
    }
    updateDoors(dt);
    const sy = player.collider.start.y - PLAYER_R;
    player.visualY = sy > player.visualY ? player.visualY + (sy - player.visualY) * Math.min(1, dt * 16) : sy;
    avatar.root.position.set(player.collider.start.x, player.visualY, player.collider.start.z);
    avatar.root.rotation.y = player.facing;
    animateAvatar(avatar, dt, Math.hypot(player.vel.x, player.vel.z), player.airTime < 0.12, player.vel.y);
    net.update(dt);
    if (fixedCam) { camera.position.set(fixedCam[0], fixedCam[1], fixedCam[2]); camera.lookAt(fixedCam[3], fixedCam[4], fixedCam[5]); }
    else if (started) updateCamera(dt);
    else menuOrbit(dt);
    if (!hud.classList.contains('hidden')) drawMap();
    if (params.has('debug')) { const c = player.collider.start; exploredEl.textContent = `${c.x.toFixed(2)}, ${(c.y - PLAYER_R).toFixed(2)}, ${c.z.toFixed(2)} ${dbgInfo}`; }
    renderer.render(scene, camera);
  });
}

// menu backdrop: slow orbit around the building while loading / in the menu
let orbitAngle = 0.3;
function menuOrbit(dt) {
  orbitAngle += dt * 0.08;
  camera.position.set(-6 + Math.cos(orbitAngle) * 42, 20, 2 + Math.sin(orbitAngle) * 42);
  camera.lookAt(-6, 0, 2);
}
{
  const preload = () => {
    if (!playBtn.disabled) return; // main loop has taken over
    menuOrbit(1 / 60);
    renderer.render(scene, camera);
    requestAnimationFrame(preload);
  };
  preload();
}
