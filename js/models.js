// Модели мебели. Каждая собирается кодом из простых фигур - никаких
// файлов моделей скачивать не нужно, и стиль получается единым low-poly.
//
// Договорённость для всех моделей:
//  - одна клетка = 1 единица, размер модели берётся из catalog.json (w, d, h);
//  - мебель для пола: центр основания в (0, 0, 0), лицом к +z;
//  - мебель для стены: центр в (0, 0, 0), задней стороной на плоскости z = 0, лицом к +z.
// Чтобы добавить предмет: запись в catalog.json и функция-строитель ниже
// с тем же id. Без строителя предмет нарисуется простым блоком.
// Обоям и полу строители не нужны: их образец собирается по их цветам.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { applyFinish, DEFAULT_THEME, floorRoughness, floorTexture, wallTexture } from './finish.js';

const C = {
  dark: 0x2c303b,
  darker: 0x1d2028,
  wood: 0x9c6b47,
  woodLight: 0xc08a5c,
  woodDark: 0x6e4a33,
  red: 0xd9443d,
  white: 0xeef0f4,
  blue: 0x5577e8,
  blueLight: 0x7d97f0,
  green: 0x4fae6c,
  greenDark: 0x2f8653,
  pot: 0xc9724b,
  metal: 0x3b404c,
  rug: 0x8a97ad,
  rugInner: 0xa3aec1,
  cyan: 0x3ff0de,
  warm: 0xffb45c,
};

// --- кэш материалов и форм: одинаковые детали не создаются заново ---

const materials = new Map();
export function mat(color, { rough = 0.78, metal = 0.04, emissive = 0x000000, glow = 0, flat = false } = {}) {
  const key = [color, rough, metal, emissive, glow, flat].join('|');
  if (!materials.has(key)) {
    materials.set(key, new THREE.MeshStandardMaterial({
      color, roughness: rough, metalness: metal, emissive, emissiveIntensity: glow, flatShading: flat,
    }));
  }
  return materials.get(key);
}

const geometries = new Map();
function roundedBox(w, h, d, r) {
  const radius = Math.max(0, Math.min(r, w / 2 - 0.002, h / 2 - 0.002, d / 2 - 0.002));
  const key = `${w}|${h}|${d}|${radius.toFixed(3)}`;
  if (!geometries.has(key)) {
    geometries.set(key, radius > 0.006 ? new RoundedBoxGeometry(w, h, d, 2, radius) : new THREE.BoxGeometry(w, h, d));
  }
  return geometries.get(key);
}

function place(g, geometry, material, x, y, z) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  return m;
}

const box = (g, w, h, d, material, x = 0, y = 0, z = 0, r = 0.035) => place(g, roundedBox(w, h, d, r), material, x, y, z);
const cylinder = (g, rTop, rBottom, h, material, x = 0, y = 0, z = 0, segments = 18) =>
  place(g, new THREE.CylinderGeometry(rTop, rBottom, h, segments), material, x, y, z);
function blob(g, radius, material, x, y, z, sx = 1, sy = 1, sz = 1, detail = 0) {
  const m = place(g, new THREE.IcosahedronGeometry(radius, detail), material, x, y, z);
  m.scale.set(sx, sy, sz);
  return m;
}

// Мягкое свечение вместо настоящих источников света: лампы и неон
// светятся, но сцене не нужно пересобирать шейдеры при каждой покупке
let glowTexture = null;
function makeGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function glow(g, color, size, x, y, z, opacity = 0.5) {
  glowTexture ??= makeGlowTexture();
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture, color, opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  sprite.scale.set(size, size, 1);
  sprite.position.set(x, y, z);
  sprite.renderOrder = 10;
  sprite.userData.glow = { base: opacity };
  g.add(sprite);
  return sprite;
}

// Пятно света на полу или стене - та же текстура, но плоская
function lightPool(g, color, size, x, y, z, opacity = 0.35, rotateX = -Math.PI / 2) {
  glowTexture ??= makeGlowTexture();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({
    map: glowTexture, color, opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  m.rotation.x = rotateX;
  m.position.set(x, y, z);
  m.renderOrder = 9;
  m.userData.glow = { base: opacity };
  g.add(m);
  return m;
}

// Детерминированный «случайный» генератор: книги на полке всегда одинаковые
function seeded(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// --- мебель для пола ---

function bed(g, t) {
  const W = t.w - 0.12, D = t.d - 0.12;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    box(g, 0.14, 0.12, 0.14, mat(C.woodDark), sx * (W / 2 - 0.1), 0.06, sz * (D / 2 - 0.1));
  }
  box(g, W, 0.28, D, mat(C.wood), 0, 0.26, 0, 0.05);
  box(g, W - 0.1, 0.26, D - 0.18, mat(C.white), 0, 0.52, 0.04, 0.08);
  box(g, W - 0.04, 0.1, D * 0.6, mat(C.blue), 0, 0.67, D / 2 - D * 0.3 - 0.02, 0.05);
  box(g, W - 0.02, 0.12, 0.16, mat(C.blueLight), 0, 0.69, D / 2 - D * 0.6, 0.05);
  box(g, 0.78, 0.16, 0.42, mat(C.white, { rough: 0.9 }), -0.42, 0.72, -D / 2 + 0.42, 0.08);
  box(g, 0.78, 0.16, 0.42, mat(C.white, { rough: 0.9 }), 0.42, 0.72, -D / 2 + 0.42, 0.08);
  box(g, W, 1.05, 0.14, mat(C.wood), 0, 0.55, -D / 2 + 0.07, 0.05);
}

function desk(g, t) {
  const W = t.w - 0.1, D = t.d - 0.1;
  box(g, W, 0.08, D, mat(C.dark), 0, 0.78, 0, 0.03);
  box(g, W, 0.025, 0.03, mat(C.red, { emissive: C.red, glow: 0.35 }), 0, 0.78, D / 2);
  for (const sx of [-1, 1]) {
    box(g, 0.08, 0.74, D - 0.1, mat(C.darker), sx * (W / 2 - 0.12), 0.37, 0);
    box(g, 0.09, 0.5, 0.03, mat(C.red), sx * (W / 2 - 0.12), 0.42, D / 2 - 0.1);
  }
  const screen = mat(0x16223a, { emissive: 0x5c8cff, glow: 0.55 });
  [[-0.92, 0.34], [0, 0], [0.92, -0.34]].forEach(([x, angle]) => {
    const monitor = new THREE.Group();
    box(monitor, 0.86, 0.5, 0.05, mat(C.darker), 0, 0, 0, 0.02);
    box(monitor, 0.8, 0.44, 0.01, screen, 0, 0, 0.03, 0);
    monitor.position.set(x, 1.24, -D / 2 + 0.2 + Math.abs(angle) * 0.35);
    monitor.rotation.y = angle;
    g.add(monitor);
    box(g, 0.05, 0.36, 0.05, mat(C.metal), x, 0.98, -D / 2 + 0.16 + Math.abs(angle) * 0.35);
  });
  box(g, 0.28, 0.02, 0.18, mat(C.metal), 0, 0.83, -D / 2 + 0.17);
  box(g, 0.95, 0.03, 0.26, mat(0x2b2b30, { emissive: 0xff8a3d, glow: 0.9 }), 0, 0.835, 0.12, 0.01);
  box(g, 0.08, 0.03, 0.12, mat(C.darker, { emissive: C.red, glow: 0.4 }), 0.66, 0.835, 0.16, 0.015);
  glow(g, 0xff9a4d, 0.9, 0, 0.9, 0.15, 0.35);
}

function chair(g) {
  for (let i = 0; i < 5; i++) {
    const leg = box(g, 0.36, 0.04, 0.06, mat(C.metal), 0, 0.07, 0);
    leg.rotation.y = (i * Math.PI * 2) / 5;
    leg.position.set(Math.cos(-leg.rotation.y) * 0.16, 0.07, Math.sin(-leg.rotation.y) * 0.16);
  }
  cylinder(g, 0.04, 0.05, 0.3, mat(C.metal), 0, 0.26, 0);
  box(g, 0.7, 0.14, 0.66, mat(C.darker), 0, 0.46, 0.02, 0.06);
  box(g, 0.66, 0.9, 0.13, mat(C.darker), 0, 0.98, -0.28, 0.06);
  for (const sx of [-1, 1]) {
    box(g, 0.08, 0.84, 0.14, mat(C.red), sx * 0.18, 0.98, -0.28, 0.03);
    box(g, 0.06, 0.26, 0.06, mat(C.metal), sx * 0.36, 0.64, 0.02);
    box(g, 0.1, 0.05, 0.42, mat(C.darker), sx * 0.36, 0.78, 0.02, 0.02);
  }
  box(g, 0.34, 0.14, 0.1, mat(C.red), 0, 1.33, -0.21, 0.05);
}

function bookshelf(g, t) {
  const W = t.w - 0.1, D = t.d - 0.2, H = t.height - 0.1;
  box(g, W, H, 0.05, mat(C.woodDark), 0, H / 2, -D / 2 + 0.025, 0.01);
  for (const sx of [-1, 1]) box(g, 0.08, H, D, mat(C.wood), sx * (W / 2 - 0.04), H / 2, 0, 0.02);
  const shelves = 4;
  const gap = (H - 0.08) / shelves;
  for (let k = 0; k <= shelves; k++) box(g, W, 0.06, D, mat(C.wood), 0, 0.04 + k * gap, 0, 0.015);

  const random = seeded(7);
  const colors = [0xe35d5b, 0x5577e8, 0xf2b544, 0x57b894, 0x9b6bd6, 0xeef0f4, 0x2c303b];
  for (let k = 0; k < shelves; k++) {
    let x = -W / 2 + 0.12;
    const bottom = 0.07 + k * gap;
    while (x < W / 2 - 0.2) {
      if (random() < 0.12) { x += 0.18; continue; }
      const bw = 0.06 + random() * 0.07;
      const bh = gap * (0.55 + random() * 0.3);
      box(g, bw, bh, D * 0.8, mat(colors[Math.floor(random() * colors.length)]), x + bw / 2, bottom + bh / 2, 0.02, 0.01);
      x += bw + 0.012;
    }
  }
}

function tvstand(g, t) {
  const W = t.w - 0.1, D = t.d - 0.12;
  box(g, W, 0.66, D, mat(C.dark), 0, 0.4, 0, 0.03);
  for (const x of [-(W / 2 - 0.2), W / 2 - 0.2]) box(g, 0.1, 0.08, D - 0.2, mat(C.darker), x, 0.04, 0);
  [-0.95, 0, 0.95].forEach((x) => {
    box(g, 0.88, 0.5, 0.02, mat(C.darker), x, 0.4, D / 2);
    box(g, 0.24, 0.035, 0.035, mat(C.woodLight), x, 0.52, D / 2 + 0.02, 0.01);
  });
  box(g, W + 0.04, 0.05, D + 0.04, mat(C.wood), 0, 0.755, 0, 0.02);
  box(g, 0.5, 0.03, 0.24, mat(C.metal), 0, 0.795, -0.05);
  box(g, 0.08, 0.2, 0.06, mat(C.metal), 0, 0.9, -0.08);
  box(g, 2.3, 1.3, 0.07, mat(C.darker), 0, 1.66, -0.12, 0.02);
  box(g, 2.2, 1.2, 0.01, mat(0x0f1828, { emissive: 0x2a58b8, glow: 0.45, rough: 0.35 }), 0, 1.66, -0.08, 0);
  glow(g, 0x4f86ff, 2.6, 0, 1.66, 0.05, 0.18);
}

function drawers(g, t) {
  const W = t.w - 0.14, D = t.d - 0.18;
  box(g, W, 0.84, D, mat(C.dark), 0, 0.46, 0, 0.03);
  box(g, W + 0.05, 0.06, D + 0.05, mat(C.wood), 0, 0.91, 0, 0.02);
  [0.2, 0.46, 0.72].forEach((y) => {
    box(g, W - 0.08, 0.22, 0.02, mat(C.darker), 0, y, D / 2);
    box(g, 0.22, 0.03, 0.03, mat(C.woodLight), 0, y + 0.02, D / 2 + 0.02, 0.01);
  });
  cylinder(g, 0.05, 0.07, 0.14, mat(C.white), 0.18, 1.01, -0.1, 12);
  blob(g, 0.1, mat(C.green, { flat: true }), 0.18, 1.14, -0.1, 1, 1.1, 1);
}

function beanbag(g) {
  const fabric = mat(0x3d4252, { flat: true, rough: 0.95 });
  blob(g, 0.5, fabric, 0, 0.3, 0.02, 0.9, 0.6, 0.92, 1);
  blob(g, 0.42, fabric, 0, 0.56, -0.24, 0.85, 0.72, 0.5, 1);
  blob(g, 0.3, mat(0x4b5163, { flat: true, rough: 0.95 }), 0, 0.52, 0.1, 0.9, 0.35, 0.8, 1);
}

function plant(g) {
  cylinder(g, 0.25, 0.19, 0.42, mat(C.pot), 0, 0.21, 0, 16);
  cylinder(g, 0.28, 0.28, 0.06, mat(0xb5623f), 0, 0.44, 0, 16);
  cylinder(g, 0.24, 0.24, 0.02, mat(0x4a3526), 0, 0.46, 0, 16);
  const leaf = mat(C.green, { flat: true });
  const leafDark = mat(C.greenDark, { flat: true });
  blob(g, 0.24, leafDark, 0, 0.72, 0, 1, 1.3, 1);
  blob(g, 0.2, leaf, 0.15, 0.95, 0.05, 1, 1.2, 1);
  blob(g, 0.19, leaf, -0.15, 0.9, -0.06, 1, 1.25, 1);
  blob(g, 0.17, leafDark, 0.02, 1.15, -0.1, 1, 1.2, 1);
  blob(g, 0.14, leaf, -0.04, 1.33, 0.05, 1, 1.3, 1);
}

function lamp(g) {
  cylinder(g, 0.2, 0.24, 0.05, mat(C.darker), 0, 0.025, 0, 20);
  cylinder(g, 0.025, 0.025, 1.7, mat(C.metal, { metal: 0.4, rough: 0.4 }), 0, 0.88, 0, 10);
  cylinder(g, 0.17, 0.3, 0.38, mat(0xffe3b8, { emissive: C.warm, glow: 0.85 }), 0, 1.9, 0, 20);
  glow(g, C.warm, 1.9, 0, 1.9, 0, 0.6);
  lightPool(g, C.warm, 2.6, 0, 0.012, 0, 0.3);
}

function rug(g, t) {
  const W = t.w - 0.12, D = t.d - 0.12;
  const outer = box(g, W, 0.03, D, mat(C.rug, { rough: 1 }), 0, 0.015, 0, 0.012);
  const inner = box(g, W - 0.3, 0.032, D - 0.3, mat(C.rugInner, { rough: 1 }), 0, 0.016, 0, 0.012);
  outer.castShadow = inner.castShadow = false;
}

// --- мебель для стен ---

function neon(g, t) {
  const panel = mat(C.cyan, { emissive: C.cyan, glow: 1.4, rough: 0.4 });
  const hex = new THREE.CylinderGeometry(0.2, 0.2, 0.05, 6);
  const spots = [[-0.14, 0.62], [0.14, 0.24], [-0.14, -0.14], [0.14, -0.52]];
  for (const [x, y] of spots) {
    const m = place(g, hex, panel, x, y, 0.03);
    m.rotation.x = Math.PI / 2;
    m.castShadow = false;
  }
  glow(g, C.cyan, 1.9, 0, 0.05, 0.12, 0.45);
  lightPool(g, C.cyan, 2.4, 0, 0.05, 0.015, 0.2, 0);
}

let posterTexture = null;
function makePosterTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f1e6d2';
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = '#e35d5b';
  ctx.beginPath();
  ctx.arc(160, 100, 62, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2c303b';
  ctx.fillRect(34, 150, 150, 64);
  ctx.fillStyle = '#5577e8';
  for (let i = 0; i < 4; i++) ctx.fillRect(34, 40 + i * 22, 70, 10);
  ctx.fillStyle = '#f2b544';
  ctx.beginPath();
  ctx.arc(200, 190, 26, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function poster(g, t) {
  posterTexture ??= makePosterTexture();
  box(g, t.w - 0.14, t.h - 0.14, 0.04, mat(C.darker), 0, 0, 0.02, 0.01);
  const art = new THREE.Mesh(new THREE.PlaneGeometry(t.w - 0.26, t.h - 0.26),
    new THREE.MeshStandardMaterial({ map: posterTexture, roughness: 0.9 }));
  art.position.set(0, 0, 0.045);
  art.receiveShadow = true;
  g.add(art);
}

function wallshelf(g, t) {
  const W = t.w - 0.1;
  box(g, W, 0.06, 0.34, mat(C.wood), 0, -0.3, 0.17, 0.015);
  for (const sx of [-1, 1]) box(g, 0.05, 0.18, 0.05, mat(C.metal), sx * (W / 2 - 0.2), -0.4, 0.05);
  cylinder(g, 0.08, 0.06, 0.16, mat(C.white), -W / 2 + 0.25, -0.19, 0.17, 12);
  blob(g, 0.12, mat(C.green, { flat: true }), -W / 2 + 0.25, -0.03, 0.17, 1, 1.2, 1);
  const colors = [0xe35d5b, 0x5577e8, 0xf2b544, 0x57b894];
  colors.forEach((color, i) => box(g, 0.07, 0.3 - i * 0.03, 0.24, mat(color), 0.1 + i * 0.08, -0.12 - i * 0.015, 0.16, 0.01));
  box(g, 0.2, 0.14, 0.2, mat(C.woodLight), W / 2 - 0.25, -0.2, 0.17, 0.02);
}

// --- магазины NPC: лавка Светливки (светлая, пастельная) и лавка Темнивки
// (тёмное дерево, бархат, свечи). Эта мебель только для комнат NPC - игрокам
// она не достаётся (configs/minimap_game.yaml → npc_only) ---

const L = {
  wood: 0xe8c497, woodDark: 0xc5935f, cream: 0xfff3e2, pink: 0xf5a3bb, pinkDeep: 0xe0718f,
  mint: 0x93d9bf, sky: 0xa9d4f5, butter: 0xffe08a, lilac: 0xc9b2f0, gold: 0xe9b949,
};
const D = {
  wood: 0x3b2733, woodDark: 0x271a24, velvet: 0x5d2a7c, velvetDark: 0x3f1b57, gold: 0xd8a84a,
  candle: 0xf4e6c8, flame: 0xffb347, violet: 0xa678ff, green: 0x7dffb0, teal: 0x5ee6e0,
};

const sphere = (g, radius, material, x = 0, y = 0, z = 0, segments = 18) =>
  place(g, new THREE.SphereGeometry(radius, segments, Math.max(8, segments * 0.6 | 0)), material, x, y, z);
const torus = (g, radius, tube, material, x = 0, y = 0, z = 0, arc = Math.PI * 2) =>
  place(g, new THREE.TorusGeometry(radius, tube, 10, 32, arc), material, x, y, z);
const cone = (g, radius, h, material, x = 0, y = 0, z = 0, segments = 12) =>
  place(g, new THREE.ConeGeometry(radius, h, segments), material, x, y, z);

// Сердечко - выдавленная фигура, лежит в плоскости xy лицом к +z
let heartGeometry = null;
function heart(g, size, material, x, y, z) {
  if (!heartGeometry) {
    const s = new THREE.Shape();
    s.moveTo(0, -0.5);
    s.bezierCurveTo(-0.15, -0.35, -0.55, -0.1, -0.5, 0.18);
    s.bezierCurveTo(-0.45, 0.48, -0.08, 0.5, 0, 0.25);
    s.bezierCurveTo(0.08, 0.5, 0.45, 0.48, 0.5, 0.18);
    s.bezierCurveTo(0.55, -0.1, 0.15, -0.35, 0, -0.5);
    heartGeometry = new THREE.ExtrudeGeometry(s, { depth: 0.18, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 3, curveSegments: 12 });
    heartGeometry.translate(0, 0, -0.09);
  }
  const m = place(g, heartGeometry, material, x, y, z);
  m.scale.setScalar(size);
  return m;
}

// Картинка на холсте: вывески, узор ковра
function canvasMaterial(width, height, draw, { rough = 0.85, emissive = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.MeshStandardMaterial({ map: texture, roughness: rough, transparent: true });
  if (emissive) {
    material.emissiveMap = texture;
    material.emissive = new THREE.Color(0xffffff);
    material.emissiveIntensity = 0.35;
  }
  return material;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawHeart(ctx, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.5);
  ctx.bezierCurveTo(x - size * 0.15, y + size * 0.35, x - size * 0.55, y + size * 0.1, x - size * 0.5, y - size * 0.18);
  ctx.bezierCurveTo(x - size * 0.45, y - size * 0.48, x - size * 0.08, y - size * 0.5, x, y - size * 0.25);
  ctx.bezierCurveTo(x + size * 0.08, y - size * 0.5, x + size * 0.45, y - size * 0.48, x + size * 0.5, y - size * 0.18);
  ctx.bezierCurveTo(x + size * 0.55, y + size * 0.1, x + size * 0.15, y + size * 0.35, x, y + size * 0.5);
  ctx.fill();
}

function drawStar(ctx, x, y, r, color, points = 5) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const radius = i % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    ctx.lineTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  ctx.closePath();
  ctx.fill();
}

// Свеча с огоньком
function candle(g, x, y, z, height = 0.22, radius = 0.045) {
  cylinder(g, radius, radius * 1.05, height, mat(D.candle, { rough: 0.6 }), x, y + height / 2, z, 12);
  const flame = sphere(g, 0.03, mat(0xfff1c2, { emissive: D.flame, glow: 2.2 }), x, y + height + 0.04, z, 8);
  flame.scale.set(1, 1.7, 1);
  glow(g, D.flame, 0.5, x, y + height + 0.05, z, 0.55);
}

// Сложенная вещь в стопке на полке
function folded(g, w, color, x, y, z) {
  box(g, w, 0.07, 0.24, mat(color, { rough: 0.95 }), x, y, z, 0.025);
}

// Лавка Светливки: прилавок с розовыми филёнками и сердечками,
// касса, колокольчик и ваза с цветами
function counter_light(g, t) {
  const W = t.w - 0.08, Dp = t.d - 0.16;
  box(g, W - 0.04, 0.1, Dp - 0.02, mat(L.woodDark), 0, 0.05, 0, 0.02);
  box(g, W, 0.92, Dp, mat(L.cream), 0, 0.55, 0, 0.04);
  box(g, W + 0.1, 0.08, Dp + 0.12, mat(L.wood, { rough: 0.6 }), 0, 1.05, 0.02, 0.03);
  [-1, 0, 1].forEach((k) => {
    box(g, W / 3 - 0.16, 0.62, 0.03, mat(L.pink), k * (W / 3), 0.55, Dp / 2 + 0.005, 0.04);
    heart(g, 0.22, mat(k ? L.cream : L.pinkDeep, { rough: 0.5 }), k * (W / 3), 0.58, Dp / 2 + 0.04);
  });
  // Касса
  const register = new THREE.Group();
  register.position.set(-W / 2 + 0.45, 1.09, -0.04);
  register.rotation.y = 0.25;
  g.add(register);
  box(register, 0.46, 0.18, 0.34, mat(L.mint), 0, 0.09, 0, 0.05);
  const top = box(register, 0.42, 0.14, 0.18, mat(L.mint), 0, 0.22, -0.05, 0.04);
  top.rotation.x = -0.4;
  box(register, 0.3, 0.08, 0.02, mat(0x2f4f4f, { emissive: 0x7fffd4, glow: 0.5 }), 0, 0.24, 0.035, 0.01);
  for (let i = 0; i < 6; i++) box(register, 0.06, 0.025, 0.06, mat(L.cream), -0.12 + (i % 3) * 0.12, 0.19, 0.08 + (i > 2 ? 0.07 : 0), 0.01);
  // Колокольчик для покупателей
  cylinder(g, 0.1, 0.11, 0.03, mat(L.woodDark), 0.25, 1.105, 0.12, 16);
  sphere(g, 0.085, mat(L.gold, { metal: 0.7, rough: 0.3 }), 0.25, 1.15, 0.12, 16).scale.y = 0.8;
  sphere(g, 0.022, mat(L.gold, { metal: 0.7, rough: 0.3 }), 0.25, 1.23, 0.12, 8);
  // Ваза с цветами
  cylinder(g, 0.09, 0.07, 0.24, mat(L.sky, { rough: 0.3 }), W / 2 - 0.3, 1.21, -0.05, 14);
  [[0, 0.42, 0, L.pink], [-0.08, 0.38, 0.05, L.butter], [0.08, 0.37, 0.04, L.cream], [0.02, 0.4, -0.08, L.pinkDeep]].forEach(([dx, dy, dz, color]) => {
    cylinder(g, 0.008, 0.008, 0.2, mat(C.greenDark), W / 2 - 0.3 + dx * 0.5, 1.28 + dy * 0.2, -0.05 + dz * 0.5, 5);
    blob(g, 0.06, mat(color, { flat: true }), W / 2 - 0.3 + dx, 1.12 + dy, -0.05 + dz, 1, 0.8, 1);
  });
}

// Высокая стеклянная витрина: светлое дерево, на полках - стопки одежды,
// шляпка и тапочки, внутри тёплая подсветка
function showcase_light(g, t) {
  const W = t.w - 0.1, Dp = t.d - 0.2, H = t.height - 0.1;
  const frame = mat(L.wood);
  box(g, W, 0.12, Dp + 0.04, mat(L.woodDark), 0, 0.06, 0, 0.02);
  box(g, W, 0.08, Dp + 0.06, frame, 0, H - 0.04, 0, 0.02);
  box(g, W - 0.06, H - 0.2, 0.04, mat(L.cream), 0, H / 2, -Dp / 2 + 0.02, 0.01);
  for (const sx of [-1, 1]) box(g, 0.07, H, Dp + 0.02, frame, sx * (W / 2 - 0.035), H / 2, 0, 0.02);
  const shelves = [0.55, 1.2, 1.85];
  for (const y of shelves) box(g, W - 0.1, 0.04, Dp - 0.04, mat(L.cream), 0, y, 0, 0.01);
  const palette = [L.pink, L.sky, L.mint, L.butter, L.lilac, 0xffffff, 0xff9d6b];
  // Нижняя полка - стопки
  [-0.5, -0.12, 0.28, 0.6].forEach((x, i) => {
    for (let k = 0; k < 3 + (i % 2); k++) folded(g, 0.3, palette[(i * 2 + k) % palette.length], x, 0.6 + k * 0.075, 0.02);
  });
  // Средняя - шляпка и тапочки
  cylinder(g, 0.24, 0.24, 0.02, mat(L.butter), -0.38, 1.24, 0.02, 20);
  cylinder(g, 0.13, 0.15, 0.16, mat(L.butter), -0.38, 1.33, 0.02, 20);
  cylinder(g, 0.152, 0.152, 0.04, mat(L.pinkDeep), -0.38, 1.28, 0.02, 20);
  for (const dx of [0.22, 0.48]) {
    box(g, 0.2, 0.1, 0.28, mat(L.pink, { rough: 0.95 }), dx, 1.27, 0.02, 0.05);
    sphere(g, 0.035, mat(L.pink, { rough: 0.95 }), dx - 0.04, 1.34, 0.12, 8);
    sphere(g, 0.035, mat(L.pink, { rough: 0.95 }), dx + 0.04, 1.34, 0.12, 8);
  }
  // Верхняя - стопки поменьше и коробочка с бантом
  [-0.45, -0.1].forEach((x, i) => {
    for (let k = 0; k < 2; k++) folded(g, 0.26, palette[(i + k + 3) % palette.length], x, 1.9 + k * 0.075, 0.02);
  });
  box(g, 0.3, 0.22, 0.24, mat(L.lilac), 0.4, 1.98, 0.02, 0.03);
  box(g, 0.32, 0.04, 0.26, mat(L.pinkDeep), 0.4, 2.0, 0.02, 0.01);
  heart(g, 0.12, mat(L.pinkDeep), 0.4, 2.14, 0.02);
  // Стекло и подсветка
  const glass = new THREE.MeshStandardMaterial({ color: 0xd8f0ff, roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false });
  const pane = place(g, new THREE.PlaneGeometry(W - 0.12, H - 0.16), glass, 0, H / 2, Dp / 2 + 0.01);
  pane.castShadow = false;
  box(g, W - 0.12, 0.03, 0.03, mat(L.gold, { metal: 0.6, rough: 0.3 }), 0, H - 0.12, Dp / 2, 0.01);
  glow(g, 0xfff0c8, 1.6, 0, H - 0.3, Dp / 2 - 0.1, 0.25);
}

// Манекен на круглой подставке. В магазине мини-игры на нём - товар
// (виджет одевает его настоящей одеждой, см. room_pages/js/view.js)
function mannequin(g) {
  const shell = mat(0xf6efe6, { rough: 0.35 });
  cylinder(g, 0.34, 0.38, 0.06, mat(L.woodDark), 0, 0.03, 0, 24);
  cylinder(g, 0.3, 0.3, 0.03, mat(L.gold, { metal: 0.6, rough: 0.3 }), 0, 0.075, 0, 24);
  cylinder(g, 0.025, 0.025, 0.5, mat(L.gold, { metal: 0.6, rough: 0.3 }), 0, 0.33, 0, 8);
  for (const sx of [-1, 1]) box(g, 0.17, 0.48, 0.2, shell, sx * 0.1, 0.62, 0, 0.07);
  box(g, 0.46, 0.5, 0.29, shell, 0, 1.08, 0, 0.12);
  for (const sx of [-1, 1]) {
    const arm = box(g, 0.12, 0.42, 0.13, shell, sx * 0.3, 1.04, 0, 0.055);
    arm.rotation.z = sx * 0.13;
  }
  cylinder(g, 0.08, 0.09, 0.12, shell, 0, 1.37, 0, 12);
  const head = sphere(g, 0.36, shell, 0, 1.68, 0, 24);
  head.scale.set(1, 0.94, 0.97);
}

// Стойка-вешалка: золотистая перекладина, на плечиках - яркие кофточки
function clothes_rack(g, t) {
  const W = t.w - 0.2;
  const metal = mat(L.gold, { metal: 0.55, rough: 0.35 });
  for (const sx of [-1, 1]) {
    cylinder(g, 0.03, 0.03, 1.8, metal, sx * W / 2, 0.92, 0, 10);
    box(g, 0.08, 0.04, 0.6, metal, sx * W / 2, 0.03, 0, 0.015);
  }
  const bar = cylinder(g, 0.025, 0.025, W + 0.06, metal, 0, 1.8, 0, 10);
  bar.rotation.z = Math.PI / 2;
  const colors = [L.pink, L.mint, L.sky, L.butter, L.lilac, 0xff9d6b];
  colors.forEach((color, i) => {
    const x = -W / 2 + 0.2 + i * ((W - 0.4) / (colors.length - 1));
    const hanger = new THREE.Group();
    hanger.position.set(x, 1.76, 0);
    hanger.rotation.y = 1.25 + (i % 2 ? 0.12 : -0.08);
    g.add(hanger);
    const hook = torus(hanger, 0.035, 0.008, metal, 0, 0.05, 0, Math.PI * 1.3);
    hook.rotation.y = Math.PI / 2;
    const cloth = mat(color, { rough: 0.95 });
    box(hanger, 0.36, 0.5, 0.08, cloth, 0, -0.27, 0, 0.04);
    for (const sx of [-1, 1]) {
      const sleeve = box(hanger, 0.12, 0.26, 0.07, cloth, sx * 0.2, -0.12, 0, 0.03);
      sleeve.rotation.z = sx * 0.6;
    }
  });
}

// Зеркало в рост на деревянной подставке
function mirror_stand(g) {
  const wood = mat(L.wood);
  for (const sx of [-1, 1]) {
    box(g, 0.06, 0.06, 0.5, mat(L.woodDark), sx * 0.3, 0.03, 0, 0.02);
    box(g, 0.05, 1.3, 0.05, wood, sx * 0.36, 0.7, 0, 0.02);
  }
  const frame = torus(g, 0.38, 0.045, mat(L.pink, { rough: 0.45 }), 0, 1.45, 0);
  frame.scale.set(0.82, 1.18, 1);
  const glass = place(g, new THREE.CircleGeometry(0.38, 32), new THREE.MeshStandardMaterial({ color: 0xcfe6f7, metalness: 0.9, roughness: 0.08, emissive: 0x9fc6e8, emissiveIntensity: 0.25 }), 0, 1.45, 0.005);
  glass.scale.set(0.82, 1.18, 1);
  // Блик
  const shine = place(g, new THREE.PlaneGeometry(0.06, 0.5), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45 }), -0.12, 1.55, 0.01);
  shine.rotation.z = -0.5;
  heart(g, 0.14, mat(L.pinkDeep), 0, 1.98, 0.02);
}

// Деревянный ящик с цветами
function flower_box(g) {
  box(g, 0.74, 0.42, 0.62, mat(L.wood), 0, 0.21, 0, 0.03);
  for (const y of [0.11, 0.3]) box(g, 0.76, 0.05, 0.64, mat(L.woodDark), 0, y, 0, 0.015);
  const leaf = mat(C.green, { flat: true });
  blob(g, 0.32, leaf, 0, 0.55, 0, 1.1, 0.5, 0.95, 1);
  const colors = [L.pink, L.cream, L.butter, L.pinkDeep, L.lilac, L.pink, L.cream];
  colors.forEach((color, i) => {
    const a = i * 2.4, r = i ? 0.18 + (i % 2) * 0.06 : 0;
    blob(g, 0.085, mat(color, { flat: true }), Math.cos(a) * r, 0.7 + (i % 3) * 0.06, Math.sin(a) * r * 0.85, 1, 0.75, 1, 1);
    sphere(g, 0.03, mat(L.butter), Math.cos(a) * r, 0.75 + (i % 3) * 0.06, Math.sin(a) * r * 0.85, 8);
  });
}

// Ковёр-облачко: пушистые круги, розовые, с белым краем
function rug_cloud(g, t) {
  const W = t.w - 0.15, Dp = t.d - 0.15;
  const puffs = [[-0.32, 0.05, 0.42], [0, -0.12, 0.5], [0.32, 0.05, 0.42], [-0.12, 0.2, 0.38], [0.16, 0.2, 0.38]];
  for (const [layer, color, extra] of [[0, 0xffffff, 0.07], [1, L.pink, 0]]) {
    for (const [px, pz, pr] of puffs) {
      const disc = cylinder(g, 1, 1, 0.03, mat(color, { rough: 1 }), px * W, 0.015 + layer * 0.004, pz * Dp * 1.3, 32);
      disc.scale.set(pr * W * 0.62 + extra, 1, pr * Dp * 0.9 + extra);
      disc.castShadow = false;
    }
  }
}

// Вывеска «Лавка» с сердечком на двух верёвочках
function sign_light(g, t) {
  const W = t.w - 0.2;
  const art = canvasMaterial(512, 220, (ctx, w, h) => {
    ctx.fillStyle = '#fff3e2';
    roundRect(ctx, 6, 6, w - 12, h - 12, 46);
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#f5a3bb';
    ctx.stroke();
    ctx.fillStyle = '#9a5a3c';
    ctx.font = "800 104px 'Rubik', 'Segoe UI', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ЛАВКА', w / 2 + 30, h / 2 + 6);
    drawHeart(ctx, 72, h / 2, 76, '#e0718f');
  });
  box(g, W, 0.58, 0.06, mat(L.wood), 0, -0.12, 0.05, 0.03);
  place(g, new THREE.PlaneGeometry(W - 0.06, 0.52), art, 0, -0.12, 0.085);
  for (const sx of [-1, 1]) {
    box(g, 0.05, 0.05, 0.22, mat(L.gold, { metal: 0.6, rough: 0.3 }), sx * (W / 2 - 0.25), 0.34, 0.11, 0.01);
    const rope = cylinder(g, 0.008, 0.008, 0.2, mat(0x9a7a5c), sx * (W / 2 - 0.25), 0.25, 0.2, 5);
    rope.rotation.x = -0.6;
  }
}

// Гирлянда: провод провисает дугой, на нём лампочки и флажки
function garland(g, t) {
  const W = t.w - 0.1;
  const colors = [L.pink, L.butter, L.mint, L.sky, L.lilac];
  const sag = (x) => 0.25 - 0.32 * (1 - Math.pow((2 * x) / W, 2));
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const x = -W / 2 + (W * i) / 24;
    points.push(new THREE.Vector3(x, sag(x), 0.06));
  }
  place(g, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 40, 0.008, 5), mat(0x5b4a3a));
  for (let i = 0; i < 9; i++) {
    const x = -W / 2 + 0.17 + i * ((W - 0.34) / 8);
    const color = colors[i % colors.length];
    if (i % 2) {
      const flag = place(g, new THREE.ConeGeometry(0.1, 0.2, 3), mat(color, { rough: 0.9 }), x, sag(x) - 0.11, 0.07);
      flag.rotation.set(Math.PI, Math.PI / 6, 0);
      flag.scale.z = 0.25;
    } else {
      sphere(g, 0.05, mat(0xfff6dc, { emissive: color, glow: 1.4 }), x, sag(x) - 0.06, 0.08, 10);
      glow(g, color, 0.42, x, sag(x) - 0.06, 0.12, 0.5);
    }
  }
}

// Лавка Темнивки: тёмный резной прилавок с бархатной дорожкой,
// хрустальный шар, свечи и стопка старых книг
function counter_dark(g, t) {
  const W = t.w - 0.08, Dp = t.d - 0.16;
  const gold = mat(D.gold, { metal: 0.6, rough: 0.35 });
  box(g, W - 0.04, 0.1, Dp - 0.02, mat(D.woodDark), 0, 0.05, 0, 0.02);
  box(g, W, 0.92, Dp, mat(D.wood), 0, 0.55, 0, 0.04);
  [-1, 0, 1].forEach((k) => {
    box(g, W / 3 - 0.18, 0.6, 0.03, mat(D.woodDark), k * (W / 3), 0.55, Dp / 2 + 0.005, 0.03);
    box(g, W / 3 - 0.26, 0.02, 0.02, gold, k * (W / 3), 0.84, Dp / 2 + 0.02, 0.005);
    box(g, W / 3 - 0.26, 0.02, 0.02, gold, k * (W / 3), 0.27, Dp / 2 + 0.02, 0.005);
  });
  box(g, W + 0.1, 0.08, Dp + 0.12, mat(D.woodDark, { rough: 0.5 }), 0, 1.05, 0.02, 0.03);
  box(g, W + 0.12, 0.02, Dp + 0.14, gold, 0, 1.005, 0.02, 0.01);
  // Бархатная дорожка свисает спереди
  box(g, 0.9, 0.03, Dp + 0.16, mat(D.velvet, { rough: 1 }), 0, 1.1, 0.02, 0.01);
  box(g, 0.9, 0.36, 0.03, mat(D.velvet, { rough: 1 }), 0, 0.93, Dp / 2 + 0.09, 0.01);
  for (let i = 0; i < 6; i++) cone(g, 0.035, 0.08, gold, -0.38 + i * 0.152, 0.71, Dp / 2 + 0.09, 6).rotation.x = Math.PI;
  // Хрустальный шар на подставке
  cylinder(g, 0.1, 0.14, 0.08, gold, 0, 1.15, 0, 16);
  const ball = sphere(g, 0.2, new THREE.MeshStandardMaterial({ color: 0xc7a6ff, emissive: D.violet, emissiveIntensity: 0.55, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.85 }), 0, 1.38, 0, 28);
  ball.castShadow = false;
  sphere(g, 0.07, mat(0xffffff, { emissive: 0xe6d6ff, glow: 1.2 }), 0, 1.38, 0, 12);
  glow(g, D.violet, 1.2, 0, 1.38, 0.05, 0.45);
  // Свечи и книги
  candle(g, -W / 2 + 0.25, 1.09, -0.08, 0.26);
  candle(g, -W / 2 + 0.42, 1.09, 0.02, 0.18);
  [[0x6b2f3a, 0.09], [0x2f4a6b, 0.08], [0x3f6b3a, 0.07]].forEach(([color, h], i) => {
    const book = box(g, 0.34, h, 0.24, mat(color), W / 2 - 0.35, 1.13 + i * 0.085, -0.02, 0.015);
    book.rotation.y = (i - 1) * 0.2;
  });
}

// Бархатный подиум. В магазине мини-игры на нём стоит товар - мебель
// в уменьшенном виде (см. room_pages/js/view.js)
function pedestal(g, t) {
  const r = Math.min(t.w, t.d) / 2 - 0.12;
  cylinder(g, r, r + 0.06, 0.32, mat(0x2e2438, { rough: 0.7 }), 0, 0.16, 0, 8);
  torus(g, r + 0.01, 0.025, mat(D.gold, { metal: 0.6, rough: 0.3 }), 0, 0.32, 0).rotation.x = Math.PI / 2;
  cylinder(g, r - 0.04, r - 0.04, 0.05, mat(D.velvet, { rough: 1 }), 0, 0.345, 0, 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    sphere(g, 0.035, mat(D.gold, { metal: 0.6, rough: 0.3 }), Math.cos(a) * (r + 0.05), 0.05, Math.sin(a) * (r + 0.05), 8);
  }
  lightPool(g, D.violet, r * 2.6, 0, 0.375, 0, 0.18);
}

// Шкаф с зельями: на полках светятся склянки
function potion_shelf(g, t) {
  const W = t.w - 0.1, Dp = t.d - 0.2, H = t.height - 0.1;
  const wood = mat(D.wood);
  box(g, W, H, 0.05, mat(D.woodDark), 0, H / 2, -Dp / 2 + 0.025, 0.01);
  for (const sx of [-1, 1]) box(g, 0.09, H, Dp, wood, sx * (W / 2 - 0.045), H / 2, 0, 0.02);
  for (let k = 0; k <= 4; k++) box(g, W, 0.06, Dp, wood, 0, 0.05 + k * ((H - 0.1) / 4), 0, 0.015);
  box(g, W + 0.12, 0.1, Dp + 0.08, mat(D.woodDark), 0, H + 0.02, 0, 0.02);
  const random = seeded(19);
  const liquids = [D.green, D.violet, 0xff6fae, D.teal, 0xffc14d];
  for (let k = 0; k < 4; k++) {
    const y = 0.08 + k * ((H - 0.1) / 4);
    let x = -W / 2 + 0.2;
    while (x < W / 2 - 0.2) {
      const color = liquids[Math.floor(random() * liquids.length)];
      const kind = random();
      const glass = mat(color, { emissive: color, glow: 0.7, rough: 0.2 });
      if (kind < 0.4) {
        sphere(g, 0.1, glass, x, y + 0.1, 0, 12);
        cylinder(g, 0.03, 0.035, 0.1, mat(0xdcd2ff, { rough: 0.2 }), x, y + 0.23, 0, 8);
        x += 0.28;
      } else if (kind < 0.75) {
        cylinder(g, 0.06, 0.07, 0.24, glass, x, y + 0.13, 0, 10);
        cylinder(g, 0.035, 0.035, 0.05, mat(0x8a5a3a), x, y + 0.27, 0, 8);
        x += 0.2;
      } else {
        box(g, 0.14, 0.18, 0.1, glass, x, y + 0.1, 0, 0.03);
        cone(g, 0.04, 0.08, mat(0xdcd2ff, { rough: 0.2 }), x, y + 0.23, 0, 8);
        x += 0.22;
      }
    }
    glow(g, liquids[k % liquids.length], 1.3, 0, y + 0.18, 0.12, 0.2);
  }
}

// Канделябр: подставка, стержень и три свечи на изогнутых рожках
function candelabra(g) {
  const gold = mat(D.gold, { metal: 0.65, rough: 0.3 });
  cylinder(g, 0.2, 0.26, 0.06, gold, 0, 0.03, 0, 16);
  cylinder(g, 0.035, 0.05, 1.5, gold, 0, 0.8, 0, 10);
  sphere(g, 0.07, gold, 0, 0.6, 0, 12);
  sphere(g, 0.06, gold, 0, 1.2, 0, 12);
  for (const sx of [-1, 1]) {
    const arm = torus(g, 0.2, 0.02, gold, sx * 0.2, 1.55, 0, Math.PI / 2);
    arm.rotation.z = sx > 0 ? -Math.PI / 2 : Math.PI;
    cylinder(g, 0.06, 0.04, 0.05, gold, sx * 0.4, 1.57, 0, 12);
    candle(g, sx * 0.4, 1.6, 0, 0.24, 0.04);
  }
  cylinder(g, 0.06, 0.04, 0.05, gold, 0, 1.57, 0, 12);
  candle(g, 0, 1.6, 0, 0.32, 0.045);
}

// Котёл на ножках: внутри булькает светящееся зелье
function cauldron(g) {
  const iron = mat(0x24212b, { metal: 0.5, rough: 0.45 });
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = cylinder(g, 0.03, 0.04, 0.26, iron, Math.cos(a) * 0.26, 0.13, Math.sin(a) * 0.26, 6);
    leg.rotation.set(Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25);
  }
  const pot = place(g, new THREE.SphereGeometry(0.42, 24, 16, 0, Math.PI * 2, Math.PI * 0.3, Math.PI * 0.7), iron, 0, 0.62, 0);
  pot.scale.y = 0.9;
  torus(g, 0.35, 0.045, iron, 0, 0.92, 0).rotation.x = Math.PI / 2;
  const brew = place(g, new THREE.CircleGeometry(0.33, 28), mat(D.green, { emissive: D.green, glow: 1.1, rough: 0.3 }), 0, 0.9, 0);
  brew.rotation.x = -Math.PI / 2;
  brew.castShadow = false;
  [[0.1, 0.94, 0.05, 0.06], [-0.12, 0.93, -0.06, 0.045], [0.02, 0.95, -0.15, 0.035]].forEach(([x, y, z, r]) => {
    sphere(g, r, mat(0xb9ffd6, { emissive: D.green, glow: 0.9, rough: 0.2 }), x, y, z, 10);
  });
  glow(g, D.green, 1.4, 0, 1.05, 0, 0.45);
  for (const sx of [-1, 1]) torus(g, 0.06, 0.015, iron, sx * 0.4, 0.84, 0).rotation.y = Math.PI / 2;
}

// Друза светящихся кристаллов
function crystals(g) {
  cylinder(g, 0.32, 0.36, 0.1, mat(0x3a3344, { flat: true, rough: 0.9 }), 0, 0.05, 0, 7);
  const shards = [[0, 0, 1.0, 0.13, 0], [0.16, 0.06, 0.62, 0.09, 0.35], [-0.15, 0.04, 0.72, 0.1, -0.3], [0.05, -0.16, 0.5, 0.08, 0.25], [-0.07, 0.17, 0.45, 0.07, -0.2]];
  shards.forEach(([x, z, h, r, tilt], i) => {
    const color = i % 2 ? D.teal : D.violet;
    const shard = new THREE.Group();
    shard.position.set(x, 0.08, z);
    shard.rotation.set(z * 1.5, 0, -tilt);
    g.add(shard);
    const glass = mat(color, { emissive: color, glow: 0.6, rough: 0.15, flat: true });
    cylinder(shard, r, r * 1.05, h, glass, 0, h / 2, 0, 6);
    cone(shard, r, r * 2.2, glass, 0, h + r * 1.1, 0, 6);
  });
  glow(g, D.violet, 1.5, 0, 0.7, 0, 0.4);
}

// Круглый звёздный ковёр: тёмно-синий, золотая кайма, луна и звёзды
function rug_stars(g, t) {
  const r = Math.min(t.w, t.d) / 2 - 0.08;
  const art = canvasMaterial(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#d8a84a';
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1f1d3d';
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 18, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(216, 168, 74, 0.7)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2 - 44, 0, Math.PI * 2); ctx.stroke();
    // Месяц
    ctx.fillStyle = '#f3dd9a';
    ctx.beginPath(); ctx.arc(w / 2, h / 2, 92, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1f1d3d';
    ctx.beginPath(); ctx.arc(w / 2 + 40, h / 2 - 26, 84, 0, Math.PI * 2); ctx.fill();
    const random = seeded(5);
    for (let i = 0; i < 26; i++) {
      const a = random() * Math.PI * 2, d = 120 + random() * 95;
      drawStar(ctx, w / 2 + Math.cos(a) * d, h / 2 + Math.sin(a) * d, 6 + random() * 9, i % 3 ? '#e9d28f' : '#b9a0ff');
    }
  }, { rough: 1 });
  const rugMesh = place(g, new THREE.CircleGeometry(r, 48), art, 0, 0.02, 0);
  rugMesh.rotation.x = -Math.PI / 2;
  rugMesh.castShadow = false;
  const base = cylinder(g, r, r, 0.02, mat(0x1a1830, { rough: 1 }), 0, 0.01, 0, 48);
  base.castShadow = false;
}

// Вывеска с луной: тёмная доска в золотой рамке
function sign_dark(g, t) {
  const W = t.w - 0.2;
  const art = canvasMaterial(512, 220, (ctx, w, h) => {
    ctx.fillStyle = '#2a1d33';
    roundRect(ctx, 6, 6, w - 12, h - 12, 22);
    ctx.fill();
    ctx.lineWidth = 10;
    ctx.strokeStyle = '#d8a84a';
    ctx.stroke();
    ctx.fillStyle = '#f3dd9a';
    ctx.beginPath(); ctx.arc(78, h / 2, 46, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2a1d33';
    ctx.beginPath(); ctx.arc(100, h / 2 - 16, 42, 0, Math.PI * 2); ctx.fill();
    drawStar(ctx, 132, 62, 12, '#c9a8ff');
    drawStar(ctx, 470, 52, 9, '#c9a8ff');
    drawStar(ctx, 450, 170, 7, '#e9d28f');
    ctx.fillStyle = '#c9a8ff';
    ctx.font = "800 100px 'Rubik', 'Segoe UI', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ЛАВКА', w / 2 + 44, h / 2 + 6);
  }, { emissive: true });
  box(g, W, 0.58, 0.06, mat(D.woodDark), 0, -0.05, 0.05, 0.02);
  place(g, new THREE.PlaneGeometry(W - 0.06, 0.52), art, 0, -0.05, 0.085);
  glow(g, D.violet, 1.6, 0, -0.05, 0.2, 0.18);
}

// Бархатные шторы с ламбрекеном и золотыми подхватами
function curtains(g, t) {
  const W = t.w - 0.1, H = t.h - 0.1;
  const velvet = mat(D.velvet, { rough: 1 });
  const fold = mat(D.velvetDark, { rough: 1 });
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 4; i++) {
      const x = sx * (W / 2 - 0.08 - i * 0.12);
      const panel = cylinder(g, 0.07, 0.1 + i * 0.01, H - 0.3, i % 2 ? fold : velvet, x, -0.12, 0.09, 10);
      panel.scale.z = 0.6;
    }
    const tie = torus(g, 0.16, 0.025, mat(D.gold, { metal: 0.6, rough: 0.3 }), sx * (W / 2 - 0.26), -0.25, 0.12);
    tie.scale.set(1, 0.4, 1);
  }
  box(g, W + 0.08, 0.32, 0.12, velvet, 0, H / 2 - 0.12, 0.08, 0.05);
  for (let i = 0; i < 6; i++) cone(g, 0.04, 0.1, mat(D.gold, { metal: 0.6, rough: 0.3 }), -W / 2 + 0.15 + i * ((W - 0.3) / 5), H / 2 - 0.33, 0.14, 6).rotation.x = Math.PI;
  const rod = cylinder(g, 0.025, 0.025, W + 0.2, mat(D.gold, { metal: 0.6, rough: 0.3 }), 0, H / 2 + 0.06, 0.1, 8);
  rod.rotation.z = Math.PI / 2;
}

// --- ещё мебель для комнат игроков: уют, музыка, игры, растения ---

const P = {
  teal: 0x2f9e94, tealLight: 0x4cb9ad, mustard: 0xe7b041, coral: 0xe8735a, terracotta: 0xc8643c,
  cream: 0xf3ead8, navy: 0x2b3a67, brass: 0xd4a94a, stone: 0xbdb3a6, stoneDark: 0x9a8f82,
  black: 0x1b1d24, purple: 0x3a2a63, pink: 0xff5fae, mint: 0x9fdccb, orange: 0xf0a04b,
};

// Картинки на холсте рисуются один раз на модель - дальше берутся готовые
const painted = new Map();
function paintedMaterial(key, width, height, draw, options) {
  if (!painted.has(key)) painted.set(key, canvasMaterial(width, height, draw, options));
  return painted.get(key);
}

// Стекло: прозрачное, тени не отбрасывает
function glass(g, geometry, x, y, z, { color = 0xcdeeff, opacity = 0.2 } = {}) {
  const m = place(g, geometry, new THREE.MeshStandardMaterial({
    color, transparent: true, opacity, roughness: 0.06, metalness: 0.1, depthWrite: false,
  }), x, y, z);
  m.castShadow = false;
  return m;
}

// Палка от точки a до точки b: ножки штативов, стебли, перекладины
function rod(g, a, b, r, material, segments = 8) {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
  const dir = to.clone().sub(from);
  const m = place(g, new THREE.CylinderGeometry(r, r, dir.length(), segments), material, 0, 0, 0);
  m.position.copy(from).add(to).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

// Тренога: три ножки от точки top до пола
function tripod(g, top, spread, material, r = 0.022) {
  for (let i = 0; i < 3; i++) {
    const a = Math.PI / 2 + (i * Math.PI * 2) / 3 + Math.PI / 3;
    rod(g, top, [Math.cos(a) * spread, 0.01, Math.sin(a) * spread], r, material);
  }
}

// Диван: подушки сиденья и спинки, подлокотники, жёлтая подушечка
function sofa(g, t) {
  const W = t.w - 0.12, Dp = t.d - 0.06;
  const fabric = mat(P.teal, { rough: 0.95 });
  const cushion = mat(P.tealLight, { rough: 0.95 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cylinder(g, 0.035, 0.025, 0.12, mat(C.woodDark), sx * (W / 2 - 0.12), 0.06, sz * (Dp / 2 - 0.12), 8);
  }
  box(g, W, 0.3, Dp, fabric, 0, 0.27, 0, 0.07);
  box(g, W, 0.62, 0.24, fabric, 0, 0.73, -Dp / 2 + 0.12, 0.1);
  for (const sx of [-1, 1]) box(g, 0.22, 0.52, Dp, fabric, sx * (W / 2 - 0.11), 0.5, 0, 0.09);
  const seatW = (W - 0.44) / 3;
  for (let i = 0; i < 3; i++) {
    const x = -W / 2 + 0.22 + seatW * (i + 0.5);
    box(g, seatW - 0.03, 0.16, Dp - 0.3, cushion, x, 0.5, 0.11, 0.07);
    const back = box(g, seatW - 0.05, 0.44, 0.16, cushion, x, 0.8, -Dp / 2 + 0.3, 0.07);
    back.rotation.x = -0.14;
  }
  const pillow = box(g, 0.34, 0.32, 0.12, mat(P.mustard, { rough: 0.95 }), -W / 2 + 0.42, 0.72, -0.02, 0.06);
  pillow.rotation.set(-0.3, 0.35, 0.18);
}

// Мягкое кресло на деревянных ножках
function armchair(g) {
  const fabric = mat(P.terracotta, { rough: 0.95 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = cylinder(g, 0.035, 0.022, 0.2, mat(C.woodLight), sx * 0.3, 0.1, sz * 0.27, 8);
    leg.rotation.set(sz * 0.18, 0, -sx * 0.18);
  }
  box(g, 0.8, 0.26, 0.74, fabric, 0, 0.32, 0, 0.08);
  box(g, 0.52, 0.14, 0.58, mat(0xdb7a52, { rough: 0.95 }), 0, 0.5, 0.06, 0.06);
  const back = box(g, 0.8, 0.66, 0.2, fabric, 0, 0.78, -0.29, 0.1);
  back.rotation.x = -0.12;
  for (const sx of [-1, 1]) box(g, 0.15, 0.4, 0.72, fabric, sx * 0.33, 0.52, 0, 0.07);
}

// Журнальный столик: кружка, книги, пульт
function coffee_table(g, t) {
  const W = t.w - 0.24, Dp = t.d - 0.3;
  box(g, W, 0.07, Dp, mat(C.woodLight), 0, 0.48, 0, 0.03);
  box(g, W - 0.12, 0.04, Dp - 0.1, mat(C.wood), 0, 0.16, 0, 0.02);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cylinder(g, 0.035, 0.025, 0.46, mat(C.woodDark), sx * (W / 2 - 0.08), 0.23, sz * (Dp / 2 - 0.07), 8);
  }
  cylinder(g, 0.06, 0.055, 0.12, mat(C.white), 0.38, 0.575, 0.06, 14);
  const handle = torus(g, 0.035, 0.011, mat(C.white), 0.445, 0.58, 0.06);
  handle.rotation.y = Math.PI / 2;
  cylinder(g, 0.05, 0.05, 0.01, mat(0x5a3a26), 0.38, 0.63, 0.06, 14);
  box(g, 0.34, 0.05, 0.24, mat(0x5577e8), -0.3, 0.54, 0.02, 0.01);
  const top = box(g, 0.3, 0.05, 0.22, mat(0xe35d5b), -0.28, 0.59, 0.02, 0.01);
  top.rotation.y = 0.25;
  const remote = box(g, 0.06, 0.025, 0.2, mat(C.darker), 0.08, 0.525, -0.08, 0.01);
  remote.rotation.y = -0.5;
  box(g, 0.6, 0.06, 0.3, mat(0xf2b544), 0, 0.21, 0, 0.02);
}

// Платяной шкаф: две дверцы, ящик внизу, чемодан наверху
function wardrobe(g, t) {
  const W = t.w - 0.1, Dp = t.d - 0.12;
  const wood = mat(0xb07a52);
  box(g, W - 0.04, 0.1, Dp - 0.04, mat(C.woodDark), 0, 0.05, 0, 0.02);
  box(g, W, 2.96, Dp, wood, 0, 1.58, 0, 0.03);
  box(g, W + 0.08, 0.1, Dp + 0.06, mat(C.woodDark), 0, 3.1, 0, 0.02);
  const front = Dp / 2 + 0.012;
  const door = mat(0xc8946a);
  for (const sx of [-1, 1]) {
    box(g, W / 2 - 0.08, 2.3, 0.03, door, sx * (W / 4 - 0.005), 1.88, front, 0.02);
    box(g, W / 2 - 0.24, 1.9, 0.02, mat(0xd4a47c), sx * (W / 4 - 0.005), 1.92, front + 0.02, 0.02);
    cylinder(g, 0.016, 0.016, 0.3, mat(P.brass, { metal: 0.6, rough: 0.3 }), sx * 0.07, 1.75, front + 0.05, 8);
  }
  box(g, W - 0.12, 0.38, 0.03, door, 0, 0.38, front, 0.02);
  box(g, 0.3, 0.04, 0.04, mat(P.brass, { metal: 0.6, rough: 0.3 }), 0, 0.38, front + 0.03, 0.01);
  box(g, 0.9, 0.36, 0.5, mat(0x7d4f9e), -0.3, 3.33, 0, 0.05);
  box(g, 0.9, 0.06, 0.52, mat(0xf2b544), -0.3, 3.33, 0, 0.01);
}

// Мини-холодильник в стиле ретро, на нём банки газировки
function minifridge(g) {
  const body = mat(P.mint, { rough: 0.45 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    cylinder(g, 0.04, 0.03, 0.08, mat(C.metal), sx * 0.28, 0.04, sz * 0.26, 8);
  }
  box(g, 0.76, 1.0, 0.7, body, 0, 0.58, 0, 0.12);
  box(g, 0.7, 0.012, 0.02, mat(0x6fb3a1), 0, 0.82, 0.355, 0.002);
  box(g, 0.035, 0.38, 0.04, mat(0xdfe4ea, { metal: 0.7, rough: 0.25 }), 0.28, 0.55, 0.37, 0.015);
  box(g, 0.035, 0.12, 0.04, mat(0xdfe4ea, { metal: 0.7, rough: 0.25 }), 0.28, 0.93, 0.37, 0.015);
  box(g, 0.22, 0.06, 0.01, mat(0xe35d5b), -0.14, 0.95, 0.356, 0.01);
  const cans = [[0xe35d5b, -0.16, 0.05], [0x5577e8, 0.02, -0.08], [0xf2b544, 0.17, 0.1]];
  for (const [color, x, z] of cans) {
    cylinder(g, 0.055, 0.055, 0.17, mat(color, { metal: 0.5, rough: 0.35 }), x, 1.165, z, 14);
    cylinder(g, 0.045, 0.055, 0.015, mat(0xd8dde4, { metal: 0.8, rough: 0.3 }), x, 1.257, z, 14);
  }
}

// Аквариум на тумбе: песок, водоросли, камни, рыбки и пузырьки
function aquarium(g, t) {
  const W = t.w - 0.14, Dp = t.d - 0.2;
  box(g, W, 0.74, Dp + 0.06, mat(0x3a2e2a), 0, 0.37, 0, 0.03);
  box(g, W + 0.04, 0.05, Dp + 0.1, mat(C.wood), 0, 0.765, 0, 0.02);
  const y0 = 0.79, h = 0.92, inner = W - 0.08;
  box(g, inner, 0.1, Dp - 0.04, mat(0xe6d3a3, { rough: 1 }), 0, y0 + 0.05, 0, 0.03);
  const water = place(g, new THREE.BoxGeometry(inner, h - 0.2, Dp - 0.05), new THREE.MeshStandardMaterial({
    color: 0x45c8f0, transparent: true, opacity: 0.5, roughness: 0.1, emissive: 0x1f8fc4, emissiveIntensity: 0.55, depthWrite: false,
  }), 0, y0 + 0.1 + (h - 0.2) / 2, 0);
  water.castShadow = false;
  glass(g, new THREE.BoxGeometry(W, h, Dp), 0, y0 + h / 2, 0);
  for (const [x, z, s] of [[-0.6, -0.08, 1.1], [-0.42, 0.06, 0.8], [0.55, -0.06, 1.25], [0.66, 0.08, 0.7]]) {
    blob(g, 0.07, mat(C.greenDark, { flat: true }), x, y0 + 0.14 + 0.16 * s, z, 0.6, 2.6 * s, 0.6);
    blob(g, 0.06, mat(C.green, { flat: true }), x + 0.06, y0 + 0.12 + 0.12 * s, z + 0.03, 0.6, 2 * s, 0.6);
  }
  blob(g, 0.1, mat(0x8c8f99, { flat: true }), 0.15, y0 + 0.13, 0.02, 1.4, 0.7, 1);
  blob(g, 0.07, mat(0x6f727c, { flat: true }), 0.3, y0 + 0.12, -0.06, 1.2, 0.8, 1);
  const fish = (x, y, z, color, dir) => {
    blob(g, 0.06, mat(color, { rough: 0.5 }), x, y, z, 1.5, 1, 0.6, 1);
    const tail = cone(g, 0.045, 0.08, mat(color), x - dir * 0.11, y, z, 6);
    tail.rotation.z = (-dir * Math.PI) / 2;
    sphere(g, 0.012, mat(C.darker), x + dir * 0.06, y + 0.015, z + 0.03, 6);
  };
  fish(-0.2, y0 + 0.5, 0.05, 0xff8a2a, 1);
  fish(0.3, y0 + 0.36, -0.02, 0xffd23f, -1);
  fish(-0.5, y0 + 0.64, -0.04, 0xff5f8a, 1);
  for (const [x, y] of [[0.42, 0.42], [0.44, 0.55], [0.41, 0.66], [0.43, 0.75]]) {
    sphere(g, 0.016 + y * 0.01, mat(0xe8fbff, { emissive: 0x9fe8ff, glow: 0.4 }), x, y0 + y, 0.08, 8);
  }
  // Рамка по верху и лампа
  for (const sz of [-1, 1]) box(g, W + 0.04, 0.04, 0.05, mat(0x2b2f38), 0, y0 + h, sz * (Dp / 2), 0.01);
  for (const sx of [-1, 1]) box(g, 0.05, 0.04, Dp, mat(0x2b2f38), sx * (W / 2), y0 + h, 0, 0.01);
  box(g, W * 0.6, 0.03, 0.08, mat(0xe8fbff, { emissive: 0x9fe8ff, glow: 1.2 }), 0, y0 + h + 0.02, -Dp / 2 + 0.08, 0.01);
  glow(g, 0x5fd8ff, 2.2, 0, y0 + h / 2, 0.1, 0.25);
}

// Игровой автомат: светящийся экран с пришельцами, джойстик и кнопки
function arcade(g) {
  const body = mat(P.purple, { rough: 0.6 });
  box(g, 0.78, 2.18, 0.62, body, 0, 1.09, -0.06, 0.03);
  for (const sx of [-1, 1]) box(g, 0.02, 1.8, 0.5, mat(P.pink, { emissive: P.pink, glow: 0.6 }), sx * 0.4, 1.1, -0.02, 0.01);
  const screen = paintedMaterial('arcade', 256, 200, (ctx, w, h) => {
    ctx.fillStyle = '#0b0820';
    ctx.fillRect(0, 0, w, h);
    const invader = ['00100000100', '00010001000', '00111111100', '01101110110', '11111111111', '10111111101', '10100000101', '00011011000'];
    const draw = (x0, y0, color, px = 4) => {
      ctx.fillStyle = color;
      invader.forEach((row, y) => [...row].forEach((c, x) => { if (c === '1') ctx.fillRect(x0 + x * px, y0 + y * px, px, px); }));
    };
    draw(26, 30, '#3ff0de');
    draw(100, 30, '#ff5fae');
    draw(174, 30, '#ffd23f');
    draw(62, 82, '#7dff8a');
    draw(138, 82, '#3ff0de');
    ctx.fillStyle = '#ff5fae';
    ctx.fillRect(116, 168, 24, 10);
    ctx.fillRect(124, 160, 8, 8);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(127, 136, 3, 12);
    ctx.font = "bold 16px 'Rubik', monospace";
    ctx.fillText('1UP 0420', 10, 196);
  }, { emissive: true, rough: 0.3 });
  screen.emissiveIntensity = 0.9;
  box(g, 0.66, 0.56, 0.05, mat(C.darker), 0, 1.62, 0.255, 0.02);
  place(g, new THREE.PlaneGeometry(0.58, 0.46), screen, 0, 1.62, 0.283);
  const marquee = paintedMaterial('arcade-top', 256, 72, (ctx, w, h) => {
    const gradient = ctx.createLinearGradient(0, 0, w, 0);
    gradient.addColorStop(0, '#ff5fae');
    gradient.addColorStop(1, '#7a5cff');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff6c2';
    ctx.font = "800 44px 'Rubik', 'Segoe UI', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ИГРА', w / 2, h / 2 + 2);
  }, { emissive: true });
  box(g, 0.78, 0.26, 0.2, body, 0, 2.06, 0.17, 0.02);
  place(g, new THREE.PlaneGeometry(0.7, 0.2), marquee, 0, 2.06, 0.272);
  const panel = box(g, 0.78, 0.1, 0.34, mat(C.darker), 0, 1.18, 0.33, 0.03);
  panel.rotation.x = 0.22;
  cylinder(g, 0.014, 0.014, 0.12, mat(C.metal), -0.18, 1.29, 0.36, 8);
  sphere(g, 0.045, mat(0xe35d5b, { rough: 0.3 }), -0.18, 1.36, 0.36, 12);
  [[0.06, 0x3ff0de], [0.16, 0xffd23f], [0.26, 0xff5fae]].forEach(([x, color], i) => {
    const b = cylinder(g, 0.034, 0.034, 0.04, mat(color, { emissive: color, glow: 0.5 }), x, 1.25 + (i % 2) * 0.01, 0.37 - (i % 2) * 0.05, 12);
    b.rotation.x = 0.22;
  });
  box(g, 0.16, 0.2, 0.03, mat(C.darker), 0, 0.6, 0.25, 0.01);
  box(g, 0.04, 0.1, 0.01, mat(0xffb13d, { emissive: 0xffb13d, glow: 1 }), 0, 0.62, 0.268, 0.004);
  glow(g, 0x7a5cff, 1.6, 0, 1.62, 0.4, 0.35);
}

// Синтезатор на X-стойке
function synth(g, t) {
  const W = t.w - 0.2;
  const metal = mat(C.metal, { metal: 0.5, rough: 0.4 });
  for (const sx of [-1, 1]) {
    for (const lean of [-1, 1]) {
      const leg = box(g, 0.04, 0.95, 0.04, metal, sx * (W / 2 - 0.25), 0.4, 0, 0.01);
      leg.rotation.x = lean * 0.55;
    }
  }
  rod(g, [-(W / 2 - 0.25), 0.4, 0], [W / 2 - 0.25, 0.4, 0], 0.02, metal);
  box(g, W, 0.11, 0.42, mat(C.darker), 0, 0.84, 0, 0.03);
  const keys = paintedMaterial('synth-keys', 512, 64, (ctx, w, h) => {
    const n = 29, kw = w / n;
    ctx.fillStyle = '#f4f2ee';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#9a9aa2';
    for (let i = 1; i < n; i++) ctx.fillRect(i * kw - 1, 0, 2, h);
    ctx.fillStyle = '#16161c';
    for (let i = 0; i < n - 1; i++) if (![2, 6].includes(i % 7)) ctx.fillRect((i + 1) * kw - kw * 0.3, 0, kw * 0.6, h * 0.6);
  }, { rough: 0.5 });
  const keyboard = place(g, new THREE.PlaneGeometry(W - 0.1, 0.22), keys, 0, 0.897, 0.08);
  keyboard.rotation.x = -Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    cylinder(g, 0.022, 0.022, 0.03, mat(i < 3 ? 0xe35d5b : C.white), -W / 2 + 0.2 + i * 0.1, 0.905, -0.12, 10);
  }
  box(g, 0.32, 0.01, 0.08, mat(0x103020, { emissive: 0x3dffa0, glow: 0.8 }), 0.35, 0.897, -0.12, 0.005);
}

// Гитара на стойке: корпус «санбёрст», гриф, колки
function guitar(g) {
  const metal = mat(C.darker, { metal: 0.4, rough: 0.5 });
  rod(g, [-0.22, 0.01, 0.12], [0, 0.55, -0.14], 0.016, metal);
  rod(g, [0.22, 0.01, 0.12], [0, 0.55, -0.14], 0.016, metal);
  rod(g, [0, 0.01, -0.3], [0, 0.55, -0.14], 0.016, metal);
  rod(g, [-0.2, 0.12, 0.1], [0.2, 0.12, 0.1], 0.016, metal);
  const instrument = new THREE.Group();
  instrument.position.set(0, 0.12, 0.08);
  instrument.rotation.x = -0.24;
  g.add(instrument);
  const wood = mat(0xd9702a, { rough: 0.35 });
  const edge = mat(0x5a2a12, { rough: 0.4 });
  for (const [r, y] of [[0.27, 0.34], [0.2, 0.66]]) {
    const outer = cylinder(instrument, r + 0.015, r + 0.015, 0.1, edge, 0, y, 0, 28);
    outer.rotation.x = Math.PI / 2;
    const face = cylinder(instrument, r, r, 0.105, wood, 0, y, 0, 28);
    face.rotation.x = Math.PI / 2;
  }
  const hole = cylinder(instrument, 0.075, 0.075, 0.11, mat(0x1a0f08), 0, 0.6, 0.002, 20);
  hole.rotation.x = Math.PI / 2;
  box(instrument, 0.16, 0.035, 0.03, mat(0x3a2412), 0, 0.26, 0.055, 0.008);
  box(instrument, 0.07, 0.7, 0.04, mat(0x5a3a22), 0, 1.13, 0.02, 0.01);
  box(instrument, 0.1, 0.18, 0.035, mat(0x2a1a10), 0, 1.55, 0.02, 0.02);
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
    const peg = cylinder(instrument, 0.012, 0.012, 0.06, mat(0xe8e2d6, { metal: 0.6 }), sx * 0.07, 1.5 + i * 0.05, 0.02, 6);
    peg.rotation.z = Math.PI / 2;
  }
  for (let i = 0; i < 6; i++) {
    box(instrument, 0.003, 1.3, 0.003, mat(0xeae6dc, { metal: 0.8 }), -0.025 + i * 0.01, 0.93, 0.06, 0);
  }
}

// Домик для кота: когтеточки, будка, лежанка, спящий котик
function cat_tree(g) {
  const carpet = mat(0xd9cdb8, { rough: 1 });
  const rope = mat(0xc9a46c, { rough: 1, flat: true });
  box(g, 0.9, 0.08, 0.9, carpet, 0, 0.04, 0, 0.03);
  box(g, 0.5, 0.5, 0.5, carpet, -0.18, 0.33, -0.18, 0.05);
  const door = cylinder(g, 0.13, 0.13, 0.02, mat(0x3a3028), -0.18, 0.32, 0.075, 18);
  door.rotation.x = Math.PI / 2;
  cylinder(g, 0.08, 0.08, 1.6, rope, 0.26, 0.88, 0.26, 10);
  cylinder(g, 0.08, 0.08, 1.3, rope, -0.22, 1.23, -0.22, 10);
  box(g, 0.66, 0.07, 0.6, carpet, 0.1, 1.2, 0.1, 0.03);
  box(g, 0.6, 0.07, 0.6, carpet, -0.12, 1.88, -0.12, 0.03);
  const bed = cylinder(g, 0.3, 0.27, 0.12, mat(0x8b7bff, { rough: 1 }), -0.12, 1.97, -0.12, 20);
  bed.castShadow = true;
  cylinder(g, 0.24, 0.24, 0.06, mat(0xb2a7ff, { rough: 1 }), -0.12, 2.02, -0.12, 20);
  // Котик свернулся клубком
  const fur = mat(P.orange, { rough: 0.95 });
  blob(g, 0.17, fur, -0.12, 2.1, -0.1, 1.2, 0.62, 1, 1);
  blob(g, 0.1, fur, 0.02, 2.13, 0.02, 1, 0.9, 1, 1);
  for (const sx of [-1, 1]) {
    const ear = cone(g, 0.035, 0.07, fur, 0.02 + sx * 0.05, 2.22, 0.0, 4);
    ear.rotation.z = -sx * 0.3;
  }
  const tail = torus(g, 0.16, 0.035, fur, -0.12, 2.08, -0.1, Math.PI * 1.1);
  tail.rotation.x = Math.PI / 2;
  // Игрушка на верёвочке
  cylinder(g, 0.005, 0.005, 0.3, mat(C.white), 0.4, 1.02, 0.3, 4);
  sphere(g, 0.05, mat(P.pink, { rough: 0.8 }), 0.4, 0.86, 0.3, 10);
}

// Камин из камня: огонь, поленья, полка со свечами и рамкой
function fireplace(g, t) {
  const W = t.w - 0.1, Dp = t.d - 0.3;
  const stone = mat(P.stone, { rough: 1, flat: true });
  box(g, W, 1.24, Dp, stone, 0, 0.62, -0.08, 0.03);
  box(g, W + 0.1, 0.1, Dp + 0.12, mat(0x5a3a26), 0, 1.29, -0.04, 0.02);
  box(g, W * 0.7, 0.76, Dp - 0.12, stone, 0, 1.72, -0.14, 0.03);
  for (const [x, y] of [[-0.3, 1.5], [0.18, 1.62], [-0.08, 1.86], [0.34, 1.95], [-0.36, 2.0]]) {
    box(g, 0.2, 0.09, 0.02, mat(P.stoneDark, { rough: 1 }), x, y, Dp / 2 - 0.19, 0.02);
  }
  box(g, W + 0.06, 0.08, 0.3, mat(P.stoneDark, { rough: 1 }), 0, 0.04, 0.24, 0.02);
  const random = seeded(19);
  for (let i = 0; i < 9; i++) {
    const x = -W / 2 + 0.12 + random() * (W - 0.24), y = 0.15 + random() * 1.0;
    if (Math.abs(x) < 0.46 && y < 0.85) continue;
    box(g, 0.18 + random() * 0.1, 0.1, 0.02, mat(P.stoneDark, { rough: 1 }), x, y, Dp / 2 - 0.07, 0.02);
  }
  box(g, 0.86, 0.72, 0.05, mat(0x1b1412, { rough: 1 }), 0, 0.44, Dp / 2 - 0.07, 0.04);
  for (const [x, r] of [[-0.12, 0.3], [0.12, -0.3]]) {
    const log = cylinder(g, 0.055, 0.055, 0.5, mat(0x6e4a33, { flat: true }), x, 0.17, Dp / 2 - 0.02, 8);
    log.rotation.set(0, r, Math.PI / 2);
  }
  const flame = (x, h, color, k) => {
    const f = cone(g, 0.09 * k, h, mat(color, { emissive: color, glow: 1.8 }), x, 0.2 + h / 2, Dp / 2 - 0.02, 7);
    f.castShadow = false;
  };
  flame(0, 0.42, 0xff7a1a, 1.2);
  flame(-0.14, 0.3, 0xffa531, 1);
  flame(0.15, 0.32, 0xffa531, 1);
  flame(0.02, 0.24, 0xffe27a, 0.8);
  glow(g, 0xff8a2a, 1.6, 0, 0.42, Dp / 2 + 0.05, 0.6);
  lightPool(g, 0xff9a4d, 1.8, 0, 0.012, Dp / 2 + 0.5, 0.35);
  candle(g, -W / 2 + 0.22, 1.34, -0.02, 0.2);
  candle(g, -W / 2 + 0.36, 1.34, 0.02, 0.14);
  box(g, 0.32, 0.38, 0.04, mat(P.brass, { metal: 0.6, rough: 0.35 }), W / 2 - 0.35, 1.53, -0.06, 0.01);
  box(g, 0.24, 0.3, 0.01, mat(0x9fc6e8), W / 2 - 0.35, 1.53, -0.035, 0);
}

// Студийный микрофон на стойке с поп-фильтром
function mic_stand(g) {
  const metal = mat(C.darker, { metal: 0.5, rough: 0.4 });
  tripod(g, [0, 0.42, 0], 0.32, metal);
  cylinder(g, 0.018, 0.018, 1.0, metal, 0, 0.9, 0, 8);
  rod(g, [0, 1.36, 0], [0, 1.52, 0.42], 0.014, metal);
  const mic = new THREE.Group();
  mic.position.set(0, 1.52, 0.42);
  g.add(mic);
  mic.scale.setScalar(1.45);
  cylinder(mic, 0.055, 0.05, 0.22, mat(0x3a3f4a, { metal: 0.6, rough: 0.35 }), 0, 0.06, 0, 16);
  sphere(mic, 0.058, mat(0xc4c9d2, { metal: 0.8, rough: 0.45 }), 0, 0.2, 0, 14);
  cylinder(mic, 0.058, 0.058, 0.08, mat(0xc4c9d2, { metal: 0.8, rough: 0.45 }), 0, 0.15, 0, 16);
  torus(mic, 0.085, 0.008, metal, 0, 0.1, 0).rotation.x = Math.PI / 2;
  const filter = torus(mic, 0.12, 0.012, metal, 0, 0.16, 0.2);
  filter.rotation.x = -0.2;
  glass(mic, new THREE.CircleGeometry(0.115, 24), 0, 0.16, 0.2, { color: 0x111318, opacity: 0.55 }).rotation.x = -0.2;
  sphere(mic, 0.014, mat(0xff3b3b, { emissive: 0xff3b3b, glow: 1.5 }), 0.045, 0.06, 0.04, 8);
}

// Кольцевая лампа для стрима
function ring_light(g) {
  const metal = mat(C.darker, { metal: 0.5, rough: 0.4 });
  tripod(g, [0, 0.5, 0], 0.34, metal);
  cylinder(g, 0.018, 0.018, 1.2, metal, 0, 1.08, 0, 8);
  const ring = torus(g, 0.36, 0.045, mat(0xffffff, { emissive: 0xfff4e0, glow: 1.6, rough: 0.4 }), 0, 1.72, 0.04);
  ring.castShadow = false;
  torus(g, 0.36, 0.055, metal, 0, 1.72, 0.0);
  rod(g, [0, 1.36, 0.02], [0, 1.66, 0.02], 0.012, metal);
  box(g, 0.11, 0.2, 0.015, mat(C.darker), 0, 1.72, 0.04, 0.012);
  glow(g, 0xfff4e0, 1.7, 0, 1.72, 0.1, 0.5);
}

// Кактус в горшке, с розовым цветком
function cactus(g) {
  cylinder(g, 0.22, 0.17, 0.34, mat(P.terracotta), 0, 0.17, 0, 16);
  cylinder(g, 0.24, 0.24, 0.06, mat(0xb5623f), 0, 0.35, 0, 16);
  cylinder(g, 0.2, 0.2, 0.02, mat(0xd8c19a, { rough: 1 }), 0, 0.37, 0, 16);
  const green = mat(0x4f9a52, { flat: true, rough: 0.8 });
  cylinder(g, 0.11, 0.12, 0.7, green, 0, 0.72, 0, 8);
  sphere(g, 0.11, green, 0, 1.07, 0, 8);
  for (const [sx, y0, h] of [[-1, 0.62, 0.3], [1, 0.78, 0.22]]) {
    rod(g, [0, y0, 0], [sx * 0.2, y0, 0], 0.055, green, 8);
    cylinder(g, 0.06, 0.06, h, green, sx * 0.2, y0 + h / 2, 0, 8);
    sphere(g, 0.06, green, sx * 0.2, y0 + h, 0, 8);
  }
  blob(g, 0.05, mat(0xff7fb0, { flat: true }), 0.03, 1.17, 0.02, 1, 0.7, 1);
}

// Монстера: большие резные листья на длинных черешках
let monsteraLeaf = null;
function makeMonsteraLeaf() {
  const shape = new THREE.Shape();
  const slits = [0.55, 0.95, 1.35, 1.8, 2.2, 2.6];
  for (let i = 0; i <= 72; i++) {
    const a = -Math.PI / 2 + (i / 72) * Math.PI * 2;
    let r = 1;
    const side = Math.abs(((a + Math.PI / 2) % (Math.PI * 2)) - Math.PI);
    if (slits.some((s) => Math.abs(side - s) < 0.05)) r = 0.45;
    const x = Math.cos(a) * 0.3 * r, y = 0.36 + Math.sin(a) * 0.36 * r;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  const geometry = new THREE.ShapeGeometry(shape);
  return geometry;
}

function monstera(g) {
  monsteraLeaf ??= makeMonsteraLeaf();
  cylinder(g, 0.26, 0.2, 0.42, mat(C.white, { rough: 0.5 }), 0, 0.31, 0, 18);
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI * 2) / 3;
    rod(g, [Math.cos(a) * 0.17, 0.12, Math.sin(a) * 0.17], [Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26], 0.018, mat(C.woodLight));
  }
  cylinder(g, 0.23, 0.23, 0.02, mat(0x4a3526), 0, 0.52, 0, 16);
  const stem = mat(0x3e8a4a);
  const leaves = [
    [0.2, 0.55, 1.15, 0x2f8a4a], [2.3, 0.65, 1.3, 0x3a9a55], [4.2, 0.6, 1.05, 0x2a7d43],
    [1.2, 0.2, 1.6, 0x36925a], [3.3, 0.35, 1.45, 0x2f8a4a], [5.4, 0.3, 1.5, 0x3a9a55],
  ];
  for (const [az, lean, height, color] of leaves) {
    const end = [Math.cos(az) * lean * 0.75, height, Math.sin(az) * lean * 0.75];
    rod(g, [0, 0.5, 0], end, 0.016, stem, 6);
    const leaf = new THREE.Mesh(monsteraLeaf, new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide }));
    leaf.castShadow = leaf.receiveShadow = true;
    leaf.position.set(...end);
    // Лист растёт от черешка наружу и чуть свисает
    leaf.rotation.order = 'YXZ';
    leaf.rotation.y = Math.PI / 2 - az;
    leaf.rotation.x = -1.0 - lean * 0.5;
    leaf.scale.setScalar(1.25);
    g.add(leaf);
  }
}

// Пуфик с пуговкой
function pouf(g) {
  const fabric = mat(P.mustard, { rough: 1 });
  cylinder(g, 0.32, 0.3, 0.34, fabric, 0, 0.2, 0, 24);
  const top = torus(g, 0.27, 0.06, fabric, 0, 0.37, 0);
  top.rotation.x = Math.PI / 2;
  cylinder(g, 0.28, 0.28, 0.08, fabric, 0, 0.38, 0, 24);
  cylinder(g, 0.04, 0.04, 0.02, mat(0xc4892a), 0, 0.425, 0, 12);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    box(g, 0.012, 0.3, 0.012, mat(0xc4892a), Math.cos(a) * 0.32, 0.2, Math.sin(a) * 0.32, 0);
  }
}

// Глобус на деревянной подставке
function globe(g) {
  const wood = mat(C.woodDark);
  cylinder(g, 0.24, 0.28, 0.06, wood, 0, 0.03, 0, 20);
  cylinder(g, 0.04, 0.06, 0.48, wood, 0, 0.3, 0, 12);
  const map = paintedMaterial('globe', 512, 256, (ctx, w, h) => {
    ctx.fillStyle = '#4f9bd8';
    ctx.fillRect(0, 0, w, h);
    const random = seeded(53);
    ctx.fillStyle = '#7cc46a';
    for (let i = 0; i < 9; i++) {
      const cx = random() * w, cy = 50 + random() * (h - 100), rx = 30 + random() * 60, ry = 18 + random() * 40;
      for (let k = 0; k < 6; k++) {
        ctx.beginPath();
        ctx.ellipse(cx + (random() - 0.5) * rx, cy + (random() - 0.5) * ry, rx * 0.6, ry * 0.6, random() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.fillStyle = '#e8d9a8';
    for (let i = 0; i < 14; i++) {
      ctx.beginPath();
      ctx.arc(random() * w, 60 + random() * (h - 120), 6 + random() * 10, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f4f8fb';
    ctx.fillRect(0, 0, w, 14);
    ctx.fillRect(0, h - 14, w, 14);
  }, { rough: 0.55 });
  const ball = place(g, new THREE.SphereGeometry(0.3, 32, 20), map, 0, 0.88, 0);
  ball.rotation.set(0.1, 0.8, 0.41);
  const ring = torus(g, 0.34, 0.016, mat(P.brass, { metal: 0.6, rough: 0.3 }), 0, 0.88, 0, Math.PI * 1.25);
  ring.rotation.set(0, Math.PI / 2, -Math.PI / 2 - 0.41 + Math.PI * 0.12);
  cylinder(g, 0.025, 0.025, 0.1, mat(P.brass, { metal: 0.6, rough: 0.3 }), 0, 0.55, 0, 8);
}

// Телескоп на треноге смотрит в потолок
function telescope(g) {
  const wood = mat(C.wood);
  tripod(g, [0, 0.95, 0], 0.4, wood, 0.03);
  cylinder(g, 0.07, 0.07, 0.12, mat(C.darker), 0, 1.0, 0, 12);
  const tube = new THREE.Group();
  tube.position.set(0, 1.12, 0);
  tube.rotation.x = -0.75;
  g.add(tube);
  const body = cylinder(tube, 0.1, 0.085, 1.1, mat(P.navy, { rough: 0.4, metal: 0.2 }), 0, 0, 0.1, 20);
  body.rotation.x = Math.PI / 2;
  for (const z of [-0.35, 0.3, 0.62]) {
    const band = cylinder(tube, 0.108, 0.108, 0.05, mat(P.brass, { metal: 0.7, rough: 0.3 }), 0, 0, z, 20);
    band.rotation.x = Math.PI / 2;
  }
  const lens = cylinder(tube, 0.09, 0.09, 0.01, mat(0x9fd8ff, { emissive: 0x3a7fb0, glow: 0.5, rough: 0.05 }), 0, 0, 0.656, 20);
  lens.rotation.x = Math.PI / 2;
  const eye = cylinder(tube, 0.03, 0.035, 0.16, mat(C.darker), 0, 0, -0.52, 10);
  eye.rotation.x = Math.PI / 2;
  const finder = cylinder(tube, 0.025, 0.025, 0.32, mat(C.white), 0, 0.14, 0.15, 10);
  finder.rotation.x = Math.PI / 2;
}

// Лава-лампа на круглом столике
function lava_lamp(g) {
  const wood = mat(C.woodLight);
  cylinder(g, 0.18, 0.2, 0.03, wood, 0, 0.015, 0, 18);
  cylinder(g, 0.03, 0.03, 0.42, wood, 0, 0.24, 0, 8);
  cylinder(g, 0.28, 0.28, 0.04, wood, 0, 0.47, 0, 22);
  const chrome = mat(0xd8dde4, { metal: 0.8, rough: 0.25 });
  cylinder(g, 0.07, 0.12, 0.16, chrome, 0, 0.57, 0, 16);
  glass(g, new THREE.CylinderGeometry(0.06, 0.1, 0.36, 18), 0, 0.83, 0, { color: 0xff5fae, opacity: 0.4 });
  const lava = mat(0xffa531, { emissive: 0xff7a1a, glow: 1.4 });
  for (const [x, y, r] of [[0, 0.71, 0.06], [0.015, 0.84, 0.04], [-0.01, 0.95, 0.032], [0.01, 0.76, 0.045]]) sphere(g, r, lava, x, y, 0, 10).castShadow = false;
  cylinder(g, 0.045, 0.06, 0.08, chrome, 0, 1.05, 0, 16);
  glow(g, 0xff5fae, 1.1, 0, 0.83, 0, 0.5);
}

// Напольная колонка
function speaker(g) {
  box(g, 0.56, 1.28, 0.5, mat(0x24262e, { rough: 0.7 }), 0, 0.66, -0.05, 0.04);
  const driver = (y, r) => {
    const ring = cylinder(g, r + 0.03, r + 0.03, 0.03, mat(0x3a3d46, { metal: 0.4 }), 0, y, 0.205, 24);
    ring.rotation.x = Math.PI / 2;
    const membrane = cylinder(g, r, r * 0.4, 0.04, mat(0x15161b, { rough: 0.9 }), 0, y, 0.21, 24);
    membrane.rotation.x = Math.PI / 2;
    sphere(g, r * 0.25, mat(0x2b2e36, { metal: 0.5 }), 0, y, 0.21, 12);
  };
  driver(0.46, 0.19);
  driver(0.92, 0.12);
  driver(1.16, 0.05);
  box(g, 0.56, 0.02, 0.02, mat(0x3ff0de, { emissive: 0x3ff0de, glow: 1.4 }), 0, 0.06, 0.205, 0.005);
  glow(g, 0x3ff0de, 0.9, 0, 0.06, 0.25, 0.3);
}

// Игровой компьютер: за стеклянным боком - вентиляторы с подсветкой,
// видеокарта и планки памяти
function gaming_pc(g) {
  const shell = mat(0x17181e, { rough: 0.5 });
  box(g, 0.5, 0.06, 0.88, mat(C.darker), 0, 0.03, 0, 0.02);
  box(g, 0.46, 0.06, 0.84, shell, 0, 0.09, 0, 0.02);
  box(g, 0.46, 0.06, 0.84, shell, 0, 1.07, 0, 0.02);
  box(g, 0.46, 1.04, 0.06, shell, 0, 0.58, -0.39, 0.02);
  box(g, 0.46, 1.04, 0.06, shell, 0, 0.58, 0.39, 0.02);
  box(g, 0.06, 1.04, 0.84, shell, -0.2, 0.58, 0, 0.02);
  box(g, 0.02, 0.92, 0.72, mat(0x0b0c12), -0.16, 0.58, 0, 0.005);
  // Всё внутри - пониже и ближе к задней стенке: сверху и спереди корпус
  // закрывает полость от камеры
  [[0xff5fae, 0.64], [0x3ff0de, 0.38]].forEach(([color, y]) => {
    const fan = torus(g, 0.1, 0.018, mat(color, { emissive: color, glow: 1.8 }), -0.13, y, -0.18);
    fan.rotation.y = Math.PI / 2;
    fan.castShadow = false;
    const hub = cylinder(g, 0.035, 0.035, 0.02, mat(0x2b2e36), -0.13, y, -0.18, 10);
    hub.rotation.z = Math.PI / 2;
    glow(g, color, 0.55, -0.06, y, -0.18, 0.45);
  });
  box(g, 0.22, 0.08, 0.5, mat(0x2b2e36, { metal: 0.5 }), -0.03, 0.18, -0.1, 0.01);
  box(g, 0.01, 0.02, 0.46, mat(0x7dff8a, { emissive: 0x7dff8a, glow: 1.4 }), 0.085, 0.2, -0.1, 0.004);
  for (let i = 0; i < 3; i++) box(g, 0.08, 0.16, 0.02, mat(0xffd23f, { emissive: 0xffd23f, glow: 0.9 }), -0.11, 0.66, 0.02 + i * 0.035, 0.004);
  glass(g, new THREE.PlaneGeometry(0.76, 0.96), 0.232, 0.58, 0, { color: 0xb8c4ff, opacity: 0.12 }).rotation.y = Math.PI / 2;
  box(g, 0.02, 0.9, 0.02, mat(0xff5fae, { emissive: 0xff5fae, glow: 1.2 }), 0.12, 0.58, 0.425, 0.005);
}

// Круглый коврик: кольца пастельных цветов
function rug_round(g, t) {
  const r = Math.min(t.w, t.d) / 2 - 0.08;
  const art = paintedMaterial('rug-round', 512, 512, (ctx, w, h) => {
    const rings = ['#e8735a', '#f3ead8', '#e7b041', '#f3ead8', '#2f9e94', '#f3ead8', '#e8735a'];
    rings.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, (w / 2) * (1 - i / rings.length), 0, Math.PI * 2);
      ctx.fill();
    });
  }, { rough: 1 });
  const mesh = place(g, new THREE.CircleGeometry(r, 48), art, 0, 0.022, 0);
  mesh.rotation.x = -Math.PI / 2;
  mesh.castShadow = false;
  cylinder(g, r, r, 0.02, mat(0xb85a45, { rough: 1 }), 0, 0.01, 0, 48).castShadow = false;
}

// Полосатый ковёр с бахромой
function rug_stripes(g, t) {
  const W = t.w - 0.16, Dp = t.d - 0.3;
  const art = paintedMaterial('rug-stripes', 256, 384, (ctx, w, h) => {
    const stripes = ['#2b3a67', '#f3ead8', '#e8735a', '#f3ead8', '#2f9e94', '#f3ead8', '#e7b041', '#f3ead8', '#2b3a67'];
    const sh = h / stripes.length;
    stripes.forEach((color, i) => {
      ctx.fillStyle = color;
      ctx.fillRect(0, i * sh, w, sh + 1);
    });
    ctx.fillStyle = 'rgba(0, 0, 0, 0.06)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
  }, { rough: 1 });
  const top = place(g, new THREE.PlaneGeometry(W, Dp), art, 0, 0.026, 0);
  top.rotation.x = -Math.PI / 2;
  top.castShadow = false;
  box(g, W, 0.024, Dp, mat(0x2b3a67, { rough: 1 }), 0, 0.012, 0, 0.008).castShadow = false;
  for (const sz of [-1, 1]) {
    for (let i = 0; i < 12; i++) {
      box(g, 0.025, 0.012, 0.12, mat(P.cream, { rough: 1 }), -W / 2 + 0.06 + i * ((W - 0.12) / 11), 0.008, sz * (Dp / 2 + 0.06), 0).castShadow = false;
    }
  }
}

// --- ещё для стен ---

// Настенные часы
function clock(g) {
  const face = paintedMaterial('clock', 256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#fbf6ec';
    ctx.beginPath(); ctx.arc(w / 2, h / 2, w / 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2c303b';
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const r1 = i % 3 ? 100 : 92;
      ctx.save();
      ctx.translate(w / 2 + Math.sin(a) * r1, h / 2 - Math.cos(a) * r1);
      ctx.rotate(a);
      ctx.fillRect(-3, 0, 6, i % 3 ? 14 : 22);
      ctx.restore();
    }
  }, { rough: 0.6 });
  const rim = cylinder(g, 0.38, 0.38, 0.08, mat(0xe35d5b), 0, 0, 0.05, 32);
  rim.rotation.x = Math.PI / 2;
  const dial = place(g, new THREE.CircleGeometry(0.32, 32), face, 0, 0, 0.092);
  dial.castShadow = false;
  const hour = box(g, 0.03, 0.17, 0.012, mat(C.darker), 0.04, 0.06, 0.1, 0.005);
  hour.rotation.z = -0.7;
  const minute = box(g, 0.02, 0.25, 0.012, mat(C.darker), -0.06, 0.09, 0.106, 0.005);
  minute.rotation.z = 0.6;
  cylinder(g, 0.025, 0.025, 0.02, mat(0xe35d5b), 0, 0, 0.11, 12).rotation.x = Math.PI / 2;
}

// Окно в ночь: луна и звёзды, на подоконнике цветок
function windowNight(g, t) {
  const W = t.w - 0.16, H = t.h - 0.2;
  const frame = mat(C.white, { rough: 0.6 });
  const sky = paintedMaterial('window-sky', 256, 256, (ctx, w, h) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, '#141a45');
    gradient.addColorStop(1, '#4b3a8a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    const random = seeded(61);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = `rgba(255, 255, 255, ${0.4 + random() * 0.6})`;
      ctx.fillRect(random() * w, random() * h * 0.8, 2, 2);
    }
    ctx.fillStyle = '#fff3c4';
    ctx.beginPath(); ctx.arc(180, 70, 30, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1c2152';
    ctx.beginPath(); ctx.arc(194, 60, 27, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#211a3d';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 32) ctx.lineTo(x, h - 30 - Math.sin(x * 0.05) * 14 - (x % 64 ? 10 : 30));
    ctx.lineTo(w, h);
    ctx.fill();
  }, { emissive: true, rough: 0.2 });
  box(g, W, H, 0.06, frame, 0, 0, 0.03, 0.02);
  place(g, new THREE.PlaneGeometry(W - 0.16, H - 0.16), sky, 0, 0, 0.065);
  box(g, 0.06, H - 0.12, 0.05, frame, 0, 0, 0.08, 0.01);
  box(g, W - 0.12, 0.06, 0.05, frame, 0, 0.1, 0.08, 0.01);
  box(g, W + 0.14, 0.07, 0.24, frame, 0, -H / 2 - 0.02, 0.12, 0.02);
  cylinder(g, 0.08, 0.06, 0.14, mat(P.terracotta), W / 2 - 0.22, -H / 2 + 0.085, 0.13, 12);
  blob(g, 0.11, mat(C.green, { flat: true }), W / 2 - 0.22, -H / 2 + 0.22, 0.13, 1, 1.1, 1);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const fold = cylinder(g, 0.06, 0.08, H + 0.1, mat(i % 2 ? 0xd8c6f0 : 0xe8dcf7, { rough: 1 }), sx * (W / 2 + 0.02 - i * 0.07), 0.02, 0.12, 8);
      fold.scale.z = 0.6;
    }
  }
  const rod2 = cylinder(g, 0.02, 0.02, W + 0.4, mat(P.brass, { metal: 0.6, rough: 0.3 }), 0, H / 2 + 0.08, 0.14, 8);
  rod2.rotation.z = Math.PI / 2;
  glow(g, 0x8a7bff, 2.2, 0, 0, 0.15, 0.16);
}

// Картина с горами в золотой раме
function painting(g, t) {
  const W = t.w - 0.24, H = t.h - 0.24;
  const art = paintedMaterial('painting', 384, 192, (ctx, w, h) => {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#ffc98a');
    sky.addColorStop(0.6, '#ff8f7a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff1c2';
    ctx.beginPath(); ctx.arc(250, 78, 26, 0, Math.PI * 2); ctx.fill();
    const ridge = (color, base, peaks) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, base);
      for (const [x, y] of peaks) ctx.lineTo(x, y);
      ctx.lineTo(w, base);
      ctx.lineTo(w, h);
      ctx.fill();
    };
    ridge('#8a6aa8', 120, [[60, 70], [120, 110], [190, 52], [270, 118], [330, 80]]);
    ridge('#5b4a86', 150, [[40, 128], [110, 92], [170, 140], [240, 100], [320, 150]]);
    ctx.fillStyle = '#f6f2ff';
    ctx.beginPath(); ctx.moveTo(190, 52); ctx.lineTo(176, 70); ctx.lineTo(205, 70); ctx.fill();
    ctx.fillStyle = '#3f8fb0';
    ctx.fillRect(0, 160, w, 32);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    for (let i = 0; i < 6; i++) ctx.fillRect(30 + i * 60, 170 + (i % 2) * 8, 26, 3);
  }, { rough: 0.9 });
  box(g, W + 0.14, H + 0.14, 0.06, mat(P.brass, { metal: 0.55, rough: 0.35 }), 0, 0, 0.03, 0.02);
  place(g, new THREE.PlaneGeometry(W, H), art, 0, 0, 0.062);
}

// Круглое зеркало в деревянной раме
function mirror_round(g) {
  const rim = torus(g, 0.34, 0.05, mat(C.woodLight), 0, 0, 0.05);
  rim.castShadow = true;
  const mirror = cylinder(g, 0.33, 0.33, 0.02, mat(0xcfe0ea, { metal: 0.9, rough: 0.08 }), 0, 0, 0.04, 32);
  mirror.rotation.x = Math.PI / 2;
  const shine = place(g, new THREE.PlaneGeometry(0.05, 0.4), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }), -0.08, 0.05, 0.052);
  shine.rotation.z = -0.6;
  const shine2 = place(g, new THREE.PlaneGeometry(0.025, 0.25), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 }), 0.02, 0.0, 0.052);
  shine2.rotation.z = -0.6;
  sphere(g, 0.025, mat(P.brass, { metal: 0.6, rough: 0.3 }), 0, 0.4, 0.04, 8);
}

// Неоновое сердце на прозрачной пластине
let heartCurve = null;
function neon_heart(g) {
  if (!heartCurve) {
    const points = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const x = 16 * Math.sin(a) ** 3;
      const y = 13 * Math.cos(a) - 5 * Math.cos(2 * a) - 2 * Math.cos(3 * a) - Math.cos(4 * a);
      points.push(new THREE.Vector3(x * 0.022, y * 0.022 + 0.03, 0));
    }
    heartCurve = new THREE.CatmullRomCurve3(points, true);
  }
  glass(g, new THREE.BoxGeometry(0.86, 0.8, 0.02), 0, 0, 0.02, { color: 0xffffff, opacity: 0.12 });
  const tube = place(g, new THREE.TubeGeometry(heartCurve, 96, 0.025, 8, true), mat(0xff7ac4, { emissive: 0xff3ea5, glow: 2.2, rough: 0.3 }), 0, 0, 0.06);
  tube.castShadow = false;
  glow(g, 0xff3ea5, 1.6, 0, 0.02, 0.12, 0.55);
  lightPool(g, 0xff3ea5, 1.8, 0, 0, 0.012, 0.25, 0);
}

// Дартс: мишень и два дротика
function darts(g) {
  const board = paintedMaterial('darts', 256, 256, (ctx, w, h) => {
    const cx = w / 2, cy = h / 2;
    ctx.fillStyle = '#1b1d24';
    ctx.beginPath(); ctx.arc(cx, cy, 128, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 20; i++) {
      const a0 = (i / 20) * Math.PI * 2 - Math.PI / 20, a1 = a0 + Math.PI / 10;
      const ring = (r0, r1, color) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(cx, cy, r1, a0, a1);
        ctx.arc(cx, cy, r0, a1, a0, true);
        ctx.fill();
      };
      ring(12, 104, i % 2 ? '#f1e3c4' : '#1b1d24');
      ring(62, 70, i % 2 ? '#2f8a4a' : '#d9443d');
      ring(96, 104, i % 2 ? '#2f8a4a' : '#d9443d');
    }
    ctx.fillStyle = '#2f8a4a';
    ctx.beginPath(); ctx.arc(cx, cy, 12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#d9443d';
    ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
  }, { rough: 0.9 });
  const back = cylinder(g, 0.4, 0.4, 0.06, mat(0x2b2e36), 0, 0, 0.03, 32);
  back.rotation.x = Math.PI / 2;
  place(g, new THREE.CircleGeometry(0.37, 32), board, 0, 0, 0.062);
  const dart = (x, y, color) => {
    rod(g, [x, y, 0.06], [x + 0.03, y + 0.02, 0.24], 0.008, mat(0xd8dde4, { metal: 0.8 }));
    const flight = cone(g, 0.035, 0.07, mat(color), x + 0.034, y + 0.023, 0.26, 3);
    flight.rotation.x = Math.PI / 2 + 0.2;
  };
  dart(0.02, 0.03, 0xffd23f);
  dart(-0.12, -0.09, 0x5fb4ff);
}

// Гирлянда с лампочками: провод провисает, лампочки светятся
function bulb_lights(g, t) {
  const W = t.w - 0.1;
  const points = [];
  for (let i = 0; i <= 24; i++) {
    const x = -W / 2 + (i / 24) * W;
    const sag = Math.abs(Math.sin((i / 24) * Math.PI * 2)) * 0.22;
    points.push(new THREE.Vector3(x, 0.2 - sag, 0.06));
  }
  const curve = new THREE.CatmullRomCurve3(points);
  place(g, new THREE.TubeGeometry(curve, 64, 0.008, 5, false), mat(0x2b2e36), 0, 0, 0);
  const colors = [0xffd23f, 0xff5fae, 0x3ff0de, 0x7dff8a, 0xff8a2a];
  for (let i = 0; i < 11; i++) {
    const p = curve.getPoint((i + 0.5) / 11);
    const color = colors[i % colors.length];
    cylinder(g, 0.016, 0.016, 0.04, mat(0x2b2e36), p.x, p.y - 0.03, p.z, 6);
    const bulb = sphere(g, 0.04, mat(color, { emissive: color, glow: 1.8, rough: 0.3 }), p.x, p.y - 0.08, p.z + 0.01, 10);
    bulb.scale.y = 1.3;
    bulb.castShadow = false;
    glow(g, color, 0.42, p.x, p.y - 0.08, p.z + 0.05, 0.6);
  }
}

// Табличка «В ЭФИРЕ» - горит красным
function onair(g, t) {
  const W = t.w - 0.3, H = t.h - 0.45;
  const sign = paintedMaterial('onair', 384, 128, (ctx, w, h) => {
    ctx.fillStyle = '#e8213a';
    roundRect(ctx, 0, 0, w, h, 24);
    ctx.fill();
    ctx.strokeStyle = '#ffd1d6';
    ctx.lineWidth = 6;
    roundRect(ctx, 10, 10, w - 20, h - 20, 16);
    ctx.stroke();
    ctx.fillStyle = '#fff4f5';
    ctx.font = "800 64px 'Rubik', 'Segoe UI', sans-serif";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('В ЭФИРЕ', w / 2, h / 2 + 4);
  }, { emissive: true });
  sign.emissiveIntensity = 0.8;
  box(g, W + 0.08, H + 0.08, 0.1, mat(0x1b1d24), 0, 0, 0.05, 0.03);
  place(g, new THREE.PlaneGeometry(W, H), sign, 0, 0, 0.102);
  glow(g, 0xff2a44, 1.8, 0, 0, 0.2, 0.4);
  lightPool(g, 0xff2a44, 2.2, 0, 0, 0.012, 0.22, 0);
}

// Полка с кубками: золото, серебро, бронза
function trophy_shelf(g, t) {
  const W = t.w - 0.1;
  box(g, W, 0.06, 0.3, mat(C.woodDark), 0, -0.32, 0.15, 0.015);
  for (const sx of [-1, 1]) box(g, 0.04, 0.16, 0.04, mat(C.metal), sx * (W / 2 - 0.2), -0.42, 0.04);
  const trophy = (x, k, color) => {
    const metal = mat(color, { metal: 0.85, rough: 0.25 });
    const y = -0.29;
    box(g, 0.16 * k, 0.07 * k, 0.16 * k, mat(0x2b2e36), x, y + 0.035 * k, 0.15, 0.01);
    cylinder(g, 0.02 * k, 0.04 * k, 0.12 * k, metal, x, y + 0.13 * k, 0.15, 10);
    cylinder(g, 0.11 * k, 0.04 * k, 0.18 * k, metal, x, y + 0.28 * k, 0.15, 16);
    for (const sx of [-1, 1]) {
      const handle = torus(g, 0.045 * k, 0.011 * k, metal, x + sx * 0.11 * k, y + 0.3 * k, 0.15, Math.PI);
      handle.rotation.z = -sx * Math.PI / 2;
    }
  };
  trophy(0, 1.25, 0xffc93c);
  trophy(-0.5, 0.95, 0xc9d1dc);
  trophy(0.5, 0.85, 0xd08a4a);
  glow(g, 0xffd86b, 1.2, 0, -0.02, 0.24, 0.25);
}

// Карта сокровищ: пергамент, остров, пунктир и крестик
function treasure_map(g, t) {
  const W = t.w - 0.3, H = t.h - 0.3;
  const art = paintedMaterial('treasure-map', 384, 192, (ctx, w, h) => {
    ctx.fillStyle = '#e9d3a2';
    ctx.beginPath();
    const random = seeded(67);
    ctx.moveTo(6, 6);
    for (let x = 6; x < w - 6; x += 18) ctx.lineTo(x, 4 + random() * 8);
    for (let y = 6; y < h - 6; y += 18) ctx.lineTo(w - 4 - random() * 8, y);
    for (let x = w - 6; x > 6; x -= 18) ctx.lineTo(x, h - 4 - random() * 8);
    for (let y = h - 6; y > 6; y -= 18) ctx.lineTo(4 + random() * 8, y);
    ctx.fill();
    ctx.fillStyle = 'rgba(140, 90, 40, 0.18)';
    for (let i = 0; i < 30; i++) {
      ctx.beginPath(); ctx.arc(random() * w, random() * h, 6 + random() * 18, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#b7c97a';
    ctx.strokeStyle = '#7a5a2a';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(120, 50);
    ctx.bezierCurveTo(200, 20, 300, 50, 290, 100);
    ctx.bezierCurveTo(285, 150, 190, 170, 130, 150);
    ctx.bezierCurveTo(70, 130, 70, 70, 120, 50);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#7a3a1a';
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    ctx.moveTo(30, 160);
    ctx.bezierCurveTo(90, 170, 120, 90, 170, 110);
    ctx.bezierCurveTo(210, 125, 220, 80, 245, 88);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#c8302a';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(240, 78); ctx.lineTo(258, 98); ctx.moveTo(258, 78); ctx.lineTo(240, 98);
    ctx.stroke();
    ctx.fillStyle = '#7a5a2a';
    drawStar(ctx, 340, 40, 18, '#7a5a2a', 4);
  }, { rough: 1 });
  place(g, new THREE.PlaneGeometry(W, H), art, 0, 0, 0.012);
  for (const [sx, sy] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    sphere(g, 0.025, mat(0xd9443d, { rough: 0.4 }), sx * (W / 2 - 0.08), sy * (H / 2 - 0.08), 0.03, 8);
  }
}

// --- отделка: обои и пол. В комнате они меняют стены и пол, а на карточках
// и на подиуме в лавке видно их образец ---

// Обои: уголок комнаты, оклеенный ими, и рулон перед ним
function wallpaper(g, t) {
  const theme = applyFinish(DEFAULT_THEME, t);
  const W = 1.0, H = 1.15, T = 0.07, y0 = 0.08;
  box(g, W + T, y0, W + T, mat(0x9aa1ad), -T / 2, y0 / 2, -T / 2, 0.02);
  box(g, T, H, W + T, mat(theme.wallLeft), -W / 2 - T / 2, y0 + H / 2, -T / 2, 0.01);
  box(g, W, H, T, mat(theme.wallRight), 0, y0 + H / 2, -W / 2 - T / 2, 0.01);
  const paper = (color) => {
    const material = new THREE.MeshStandardMaterial({
      map: wallTexture(theme, { background: color, repeat: [W / 0.7, H / 0.7] }), roughness: 0.9,
    });
    if (theme.patternGlow) {
      material.emissiveMap = material.map;
      material.emissive = new THREE.Color(0xffffff);
      material.emissiveIntensity = theme.patternGlow * 0.6;
    }
    return material;
  };
  const left = place(g, new THREE.PlaneGeometry(W, H), paper(theme.wallLeft), -W / 2 + 0.003, y0 + H / 2, 0);
  left.rotation.y = Math.PI / 2;
  place(g, new THREE.PlaneGeometry(W, H), paper(theme.wallRight), 0, y0 + H / 2, -W / 2 + 0.003);
  // Торцы и плинтус
  box(g, T + 0.02, 0.05, W + T + 0.02, mat(theme.trim), -W / 2 - T / 2, y0 + H + 0.025, -T / 2, 0.01);
  box(g, W + 0.02, 0.05, T + 0.02, mat(theme.trim), 0, y0 + H + 0.025, -W / 2 - T / 2, 0.01);
  box(g, 0.03, 0.08, W, mat(theme.baseboard), -W / 2 + 0.015, y0 + 0.04, 0, 0.005);
  box(g, W, 0.08, 0.03, mat(theme.baseboard), 0, y0 + 0.04, -W / 2 + 0.015, 0.005);
  // Рулон обоев
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.72, 24), [
    new THREE.MeshStandardMaterial({ map: wallTexture(theme, { background: theme.wallLeft, repeat: [1.6, 1.4] }), roughness: 0.9 }),
    mat(0xf3ede2), mat(0xf3ede2),
  ]);
  roll.rotation.z = Math.PI / 2;
  roll.rotation.y = -0.35;
  roll.position.set(0.12, y0 + 0.11, 0.3);
  roll.castShadow = roll.receiveShadow = true;
  g.add(roll);
}

// Пол: кусок пола 2×2 клетки на подставке
const floorSamples = new Map();
function flooring(g, t) {
  const theme = applyFinish(DEFAULT_THEME, t);
  const key = JSON.stringify([theme.floor, theme.floor2, theme.floorStyle]);
  if (!floorSamples.has(key)) {
    const texture = floorTexture(theme).clone();
    texture.repeat.set(0.25, 0.25);
    texture.offset.set(0.375, 0.375);
    texture.needsUpdate = true;
    floorSamples.set(key, texture);
  }
  const S = 1.2;
  box(g, S + 0.1, 0.12, S + 0.1, mat(theme.base), 0, 0.06, 0, 0.03);
  const [h, s, l] = theme.floor;
  const side = mat(new THREE.Color().setHSL(h / 360, s / 100, (l / 100) * 0.72).getHex());
  const top = new THREE.MeshStandardMaterial({ map: floorSamples.get(key), roughness: floorRoughness(theme) });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(S, 0.1, S), [side, side, top, side, side, side]);
  slab.position.y = 0.17;
  slab.castShadow = slab.receiveShadow = true;
  g.add(slab);
}

// Предмет без своей модели - просто блок нужного размера
function fallback(g, t) {
  if (t.surface === 'wall') box(g, t.w - 0.1, t.h - 0.1, 0.1, mat(C.white), 0, 0, 0.05);
  else box(g, t.w - 0.1, t.height || 1, t.d - 0.1, mat(C.white), 0, (t.height || 1) / 2, 0);
}

const BUILDERS = {
  bed, desk, chair, bookshelf, tvstand, drawers, beanbag, plant, lamp, rug, neon, poster, wallshelf,
  counter_light, showcase_light, mannequin, clothes_rack, mirror_stand, flower_box, rug_cloud, sign_light, garland,
  counter_dark, pedestal, potion_shelf, candelabra, cauldron, crystals, rug_stars, sign_dark, curtains,
  sofa, armchair, coffee_table, wardrobe, minifridge, aquarium, arcade, synth, guitar, cat_tree, fireplace,
  mic_stand, ring_light, cactus, monstera, pouf, globe, telescope, lava_lamp, speaker, gaming_pc, rug_round, rug_stripes,
  clock, window: windowNight, painting, mirror_round, neon_heart, darts, bulb_lights, onair, trophy_shelf, treasure_map,
};

// Обои и пол - образцы по их цветам, у всех одинаковые
const SURFACE_BUILDERS = { wallpaper, flooring };

export function buildModel(type) {
  const group = new THREE.Group();
  (BUILDERS[type.id] || SURFACE_BUILDERS[type.surface] || fallback)(group, type);
  group.userData.typeId = type.id;
  return group;
}
