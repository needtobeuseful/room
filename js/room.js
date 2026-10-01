// Сама комната: пол, две стены, свет и изометрическая камера.
// Комната стоит в углу координат: пол от (0, 0) до (size, size),
// левая стена - плоскость x = 0, правая - плоскость z = 0. Камера смотрит
// из угла (+x, +y, +z), поэтому передние стены «срезаны», как в макете.
//
// Вид стен и пола - тема: обычная комната, поверх - обои и пол, которые
// выбрал игрок, а у лавок NPC - их собственные (см. finish.js).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { DEFAULT_THEME, floorRoughness, floorTexture, patternMaterial } from './finish.js';

const WALL_THICKNESS = 0.35;
// Направление на камеру: изометрия (1, 1, 1) чуть приплюснута сверху
export const VIEW_DIRECTION = new THREE.Vector3(1, 0.92, 1).normalize();

function solid(geometry, color, x, y, z, { rough = 0.9 } = {}) {
  const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: rough }));
  m.position.set(x, y, z);
  m.receiveShadow = true;
  m.castShadow = true;
  return m;
}

// Как выглядят стены и пол - тема (обои и пол, см. finish.js)
export { DEFAULT_THEME, themeOf } from './finish.js';

// Узор обоев - прозрачный слой чуть впереди стены
function patternLayer(group, theme, width, height, position, rotationY) {
  const material = patternMaterial(theme, [width / 1.4, height / 1.4]);
  if (!material) return;
  const layer = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  layer.position.copy(position);
  layer.rotation.y = rotationY;
  layer.receiveShadow = true;
  group.add(layer);
}

export function buildRoom(room, theme = DEFAULT_THEME) {
  const S = room.size;
  const H = room.wallHeight;
  const T = WALL_THICKNESS;
  const group = new THREE.Group();

  // Подставка, на которой стоит комната
  group.add(solid(new RoundedBoxGeometry(S + T + 0.3, 0.5, S + T + 0.3, 3, 0.12), theme.base,
    S / 2 - T / 2, -0.26, S / 2 - T / 2));

  const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S),
    new THREE.MeshStandardMaterial({ map: floorTexture(theme), roughness: floorRoughness(theme) }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(S / 2, 0.002, S / 2);
  floor.receiveShadow = true;
  group.add(floor);

  // Стены: левая светлее, правая темнее - как на референсе
  group.add(solid(new THREE.BoxGeometry(T, H, S + T), theme.wallLeft, -T / 2, H / 2, S / 2 - T / 2));
  group.add(solid(new THREE.BoxGeometry(S, H, T), theme.wallRight, S / 2, H / 2, -T / 2));
  patternLayer(group, theme, S, H, new THREE.Vector3(0.004, H / 2, S / 2), Math.PI / 2);
  patternLayer(group, theme, S, H, new THREE.Vector3(S / 2, H / 2, 0.004), 0);

  // Белые торцы на срезе стен
  const cap = theme.trim;
  group.add(solid(new THREE.BoxGeometry(T + 0.04, 0.1, S + T + 0.04), cap, -T / 2, H + 0.05, S / 2 - T / 2));
  group.add(solid(new THREE.BoxGeometry(S + 0.02, 0.1, T + 0.04), cap, S / 2, H + 0.05, -T / 2));
  group.add(solid(new THREE.BoxGeometry(T + 0.04, H + 0.1, 0.06), cap, -T / 2, H / 2 + 0.05, S + 0.01));
  group.add(solid(new THREE.BoxGeometry(0.06, H + 0.1, T + 0.04), cap, S + 0.01, H / 2 + 0.05, -T / 2));

  // Плинтусы
  group.add(solid(new THREE.BoxGeometry(0.05, 0.16, S), theme.baseboard, 0.025, 0.08, S / 2));
  group.add(solid(new THREE.BoxGeometry(S, 0.16, 0.05), theme.baseboard, S / 2, 0.08, 0.025));

  // Сетка на полу - видна только пока что-то двигаешь
  const grid = new THREE.GridHelper(S, S, 0xffffff, 0xffffff);
  grid.position.set(S / 2, 0.012, S / 2);
  grid.material.transparent = true;
  grid.material.opacity = 0;
  grid.material.depthWrite = false;
  group.add(grid);

  const bounds = new THREE.Box3(new THREE.Vector3(-T - 0.15, -0.5, -T - 0.15), new THREE.Vector3(S + 0.15, H + 0.1, S + 0.15));
  return { group, grid, bounds };
}

export function addLights(scene, room) {
  const S = room.size;
  const center = new THREE.Vector3(S / 2, 0, S / 2);

  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x2a3142, 1.35));

  const sun = new THREE.DirectionalLight(0xfff0dc, 1.85);
  sun.position.copy(center).add(new THREE.Vector3(9, 13, 5));
  sun.target.position.copy(center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -9;
  sun.shadow.camera.right = 9;
  sun.shadow.camera.top = 9;
  sun.shadow.camera.bottom = -9;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 50;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // Тёплая подсветка изнутри комнаты
  const fill = new THREE.PointLight(0xffc58a, 14, 16, 1.6);
  fill.position.set(S * 0.65, room.wallHeight * 0.8, S * 0.65);
  scene.add(fill);
}

// Где стоит модель предмета в позиции p. lift - насколько её приподнять
// (пока предмет тащат, он «висит» над полом или отходит от стены)
export function poseFor(type, p, lift = 0) {
  if (p.surface === 'floor') {
    const odd = p.rot % 2 === 1;
    const w = odd ? type.d : type.w, d = odd ? type.w : type.d;
    return { pos: new THREE.Vector3(p.a + w / 2, lift, p.b + d / 2), rot: (p.rot * Math.PI) / 2 };
  }
  if (p.surface === 'left') {
    return { pos: new THREE.Vector3(lift, p.b + type.h / 2, p.a + type.w / 2), rot: Math.PI / 2 };
  }
  return { pos: new THREE.Vector3(p.a + type.w / 2, p.b + type.h / 2, lift), rot: 0 };
}

// Пружинка для появления и исчезновения: чуть перелетает и возвращается.
// Задержка появления - по часам, а не по кадрам: на слабом компьютере
// кадров меньше, но комната всё равно соберётся за секунду
export function springScale(item, dt, now = performance.now()) {
  if (now < item.appearAt) return;
  const force = (item.scaleTarget - item.scale) * 260 - item.scaleSpeed * 17;
  item.scaleSpeed += force * dt;
  item.scale = Math.max(0.001, item.scale + item.scaleSpeed * dt);
  item.obj.scale.setScalar(item.scale);
}

// Подгоняет ортографическую камеру так, чтобы комната целиком влезла в кадр
export function fitCamera(camera, bounds, width, height, padding = 1.08) {
  const target = bounds.getCenter(new THREE.Vector3());
  camera.position.copy(target).addScaledVector(VIEW_DIRECTION, 40);
  camera.lookAt(target);
  camera.updateMatrixWorld();

  const corner = new THREE.Vector3();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
        minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x);
        minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y);
      }
    }
  }
  let halfW = ((maxX - minX) / 2) * padding;
  let halfH = ((maxY - minY) / 2) * padding;
  const aspect = width / Math.max(1, height);
  if (halfW / halfH > aspect) halfH = halfW / aspect;
  else halfW = halfH * aspect;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  camera.left = cx - halfW;
  camera.right = cx + halfW;
  camera.top = cy + halfH;
  camera.bottom = cy - halfH;
  camera.near = 0.1;
  camera.far = 200;
  camera.updateProjectionMatrix();
}
