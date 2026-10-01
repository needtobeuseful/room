// Просмотр комнаты для виджета мини-игры в OBS.
//
// Виджет встраивает эту страницу рамкой (iframe) поверх карты. В конце
// забега бокс-комната игрока вырастает на всё поле и плавно превращается
// в эту комнату: шестиугольник бокса - это ровно силуэт комнаты (две стены
// и пол), поэтому виджет говорит, куда его положить, и камера ставится так,
// чтобы силуэт комнаты совпал с выросшим боксом пиксель в пиксель.
//
// Ещё эта страница рисует фигурку игрока (модель - с сайта персонажа,
// который бот раздаёт рядом, по адресу /avatar/). Пока игрок ходит по
// полю, виджет показывает её картинками - по одной на каждую сторону, куда
// фигурка смотрит. Картинки нарисованы в том же масштабе, при том же свете
// и с той же точки, что и комната, поэтому в конце забега картинка
// незаметно сменяется настоящей фигуркой в комнате.
//
// Сообщения от виджета (postMessage):
//   {type: 'prepare', token, room, look, target: {cx, cy, hexWidth}}
//       собрать комнату по коду, но пока не показывать. В ответ
//       {type: 'prepared', token, colors, spot, count, figure}: цвета стен
//       и пола (виджет перекрашивает в них бокс, пока тот растёт), клетка
//       пола, куда встанет персонаж, и картинки фигурки:
//       figure = {down, up, left, right, sleep, width, height, anchor, head, blinks, skin}:
//       четыре стороны, sleep - лицом к зрителю с закрытыми глазами (сон,
//       моргание), anchor - где на картинке ноги, head - где голова,
//       blinks - моргает ли (глаза-дужки и так закрыты), skin - цвет кожи
//       (в него виджет красит руку, что гладит котят и ломает сундуки);
//   {type: 'target', target} - виджет поменял размер;
//   {type: 'show'}   - мебель выпрыгивает по очереди, фигурка стоит на месте;
//   {type: 'hide'}   - убрать всё и перестать рисовать;
//   {type: 'thumbs'} - картинки всей мебели: {type: 'thumbs', urls: {id: png}};
//   {type: 'outfit', token, look, item} - фигурка в новой вещи
//       для карточки находки: {type: 'outfit', token, url}.
//
// Ещё эта страница рисует лавку NPC (виджет держит для неё вторую рамку):
//   {type: 'prepare', ..., theme, shop: {npc, goods, sold}} - комната
//       лавки: её обои и пол - из кода комнаты, а если их там нет - из темы
//       theme (catalog.json → themes); за прилавком продавец в образе npc,
//       персонаж игрока у входа, товары на манекенах и подиумах. В ответе
//       prepared ещё и shop: где продавец, где покупатель, сколько прыжков
//       до прилавка, точки над товарами (там виджет пишет их номера) и
//       картинки товаров для карточек. Подробности - в shop.js;
//   {type: 'walk', to: 'counter' | 'door'} - персонаж прыгает к прилавку
//       или обратно ко входу;
//   {type: 'react', kind} - продавец машет (wave), радуется (happy),
//       качает головой (no), протягивает товар (give);
//   {type: 'sell', index} - товар продан: исчезает с манекена или подиума;
//   {type: 'jump'} - персонаж подпрыгивает на месте.
// Сама страница присылает {type: 'loaded', figure: есть ли фигурки},
// а если что-то сломалось - {type: 'error', message}.
//
// Открытая напрямую (не в рамке), страница просто показывает комнату
// из ссылки: view.html#r=КОМНАТА&l=ОБРАЗ.

import * as THREE from 'three';
import { addLights, buildRoom, fitCamera, poseFor, springScale, themeOf, VIEW_DIRECTION } from './room.js';
import { figurePoints, Shop, SHOP_HOP_GAP_MS } from './shop.js';
import { buildModel } from './models.js';
import { Layout } from './layout.js';
import { finishesOf, isFinish } from './finish.js';
import { decodeLook, decodeRoom } from './codec.js';
import { makeThumbnails } from './thumbs.js';

const embedded = window.parent !== window;
const tell = (message) => { if (embedded) window.parent.postMessage(message, '*'); };

let catalog;
try {
  catalog = await fetch('catalog.json', { cache: 'no-cache' }).then((response) => {
    if (!response.ok) throw new Error(`catalog.json: ${response.status}`);
    return response.json();
  });
} catch (error) {
  tell({ type: 'error', message: String(error.message || error) });
  throw error;
}

// Фигурка игрока. Сайт комнаты, выложенный отдельно на GitHub, её не знает -
// тогда просто обходимся без неё
let kit = null;
try {
  const figure = await import('/avatar/js/figure.js');
  const wardrobeCatalog = await fetch('/avatar/catalog.json', { cache: 'no-cache' }).then((response) => {
    if (!response.ok) throw new Error(`avatar/catalog.json: ${response.status}`);
    return response.json();
  });
  kit = { ...figure, wardrobe: new figure.Wardrobe(wardrobeCatalog) };
} catch (error) {
  kit = null;
}

const ROOM = catalog.room;
const S = ROOM.size;
const H = ROOM.wallHeight;
const typeByCode = new Map(catalog.items.map((type) => [type.code, type]));

const canvas = document.getElementById('scene');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
} catch (error) {
  tell({ type: 'error', message: 'WebGL недоступен' });
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera();
let room = buildRoom(ROOM, themeOf(catalog, null));
let themeKey = '';
scene.add(room.group);
addLights(scene, ROOM);

// Стены и пол: обои и пол комнаты (finishes), а чего в комнате нет - из
// темы name (у лавок своя) или как в обычной комнате
function setTheme(name, finishes = []) {
  const theme = themeOf(catalog, name, finishes);
  const key = JSON.stringify(theme);
  if (key === themeKey) return;
  themeKey = key;
  scene.remove(room.group);
  room = buildRoom(ROOM, theme);
  scene.add(room.group);
}

// Внутренний силуэт комнаты - те же шесть углов, что у бокса в виджете
const CORNERS = [
  new THREE.Vector3(0, H, 0), new THREE.Vector3(S, H, 0), new THREE.Vector3(S, 0, 0),
  new THREE.Vector3(S, 0, S), new THREE.Vector3(0, 0, S), new THREE.Vector3(0, H, S),
];
const CENTER = new THREE.Vector3(S / 2, H / 2, S / 2);

let items = [];
let figure = null;       // фигурка игрока в комнате
let shop = null;         // лавка NPC (shop.js), если показываем лавку
let target = null;       // куда положить силуэт: {cx, cy, hexWidth} в пикселях рамки
let pixelsPerUnit = 1;
let showing = false;

// ---------------------------------------------------------------- камера

function size() {
  return { width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) };
}

function placeCamera() {
  const { width, height } = size();
  renderer.setSize(width, height, false);
  if (!target) {
    fitCamera(camera, room.bounds, width, height);
    pixelsPerUnit = width / (camera.right - camera.left);
    return;
  }
  camera.position.copy(CENTER).addScaledVector(VIEW_DIRECTION, 40);
  camera.lookAt(CENTER);
  camera.updateMatrixWorld();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const corner of CORNERS) {
    const v = corner.clone().applyMatrix4(camera.matrixWorldInverse);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  pixelsPerUnit = target.hexWidth / (maxX - minX);
  camera.left = (minX + maxX) / 2 - target.cx / pixelsPerUnit;
  camera.right = camera.left + width / pixelsPerUnit;
  camera.top = (minY + maxY) / 2 + target.cy / pixelsPerUnit;
  camera.bottom = camera.top - height / pixelsPerUnit;
  camera.near = 0.1;
  camera.far = 200;
  camera.updateProjectionMatrix();
}

// Точка сцены -> пиксели рамки
function toPixels(point) {
  const v = point.clone().applyMatrix4(camera.matrixWorldInverse);
  return { x: (v.x - camera.left) * pixelsPerUnit, y: (camera.top - v.y) * pixelsPerUnit };
}

// ---------------------------------------------------------------- мебель

function clearItems() {
  for (const item of items) scene.remove(item.obj);
  items = [];
  if (figure) scene.remove(figure);
  figure = null;
  if (shop) shop.dispose();
  shop = null;
}

// Мебель комнаты по коду, а обои и пол - стены и пол комнаты
function build(code, themeName = null) {
  clearItems();
  const layout = new Layout(ROOM);
  let placements = [];
  if (code) {
    try {
      placements = decodeRoom(code);
    } catch (error) {
      tell({ type: 'error', message: `код комнаты: ${error.message}` });
    }
  }
  setTheme(themeName, finishesOf(placements.map((p) => typeByCode.get(p.code))));
  for (const p of placements) {
    const type = typeByCode.get(p.code);
    if (!type || isFinish(type)) continue;
    if ((type.surface === 'wall') !== (p.surface !== 'floor') || !layout.check(type, p).ok) continue;
    const obj = buildModel(type);
    const pose = poseFor(type, p);
    obj.position.copy(pose.pos);
    obj.rotation.y = pose.rot;
    obj.scale.setScalar(0.001);
    obj.visible = false;
    const item = { type, obj, surface: p.surface, a: p.a, b: p.b, rot: p.rot, uid: items.length,
      scale: 0.001, scaleTarget: 1, scaleSpeed: 0, appearAt: Infinity, glows: [], hidden: false };
    obj.traverse((o) => { if (o.userData.glow) item.glows.push(o); });
    scene.add(obj);
    layout.add(item);
    items.push(item);
  }
  return layout;
}

// Свободная клетка пола для персонажа: поближе к переднему краю комнаты,
// чтобы его не заслоняла мебель. Персонаж на экране шире клетки, поэтому
// лучше, чтобы и вокруг было свободно - особенно спереди и по бокам
// (на экране «бока» клетки - это соседи по диагонали a+1,b-1 и a-1,b+1)
const AROUND = [[1, 1, 3], [1, 0, 2], [0, 1, 2], [1, -1, 2], [-1, 1, 2], [-1, 0, 0.5], [0, -1, 0.5], [-1, -1, 0.3]];
function findCell(layout) {
  const probe = { surface: 'floor', w: 1, d: 1, height: 1, name: '' };
  const free = (a, b) => a < 0 || b < 0 || a >= S || b >= S || layout.check(probe, { surface: 'floor', a, b, rot: 0 }).ok;
  let best = null;
  for (let a = 0; a < S; a++) {
    for (let b = 0; b < S; b++) {
      if (!free(a, b)) continue;
      let score = Math.hypot(a - S * 0.6, b - S * 0.6) * 0.6 + Math.abs(a - b) * 0.2;
      for (const [da, db, weight] of AROUND) if (!free(a + da, b + db)) score += weight;
      if (!best || score < best.score) best = { a, b, score };
    }
  }
  return best;
}

// Средний цвет кусочка кадра - чтобы бокс в виджете перекрасился
// ровно в те цвета, которые получились у стен и пола после света
function sampleColor(point) {
  const gl = renderer.getContext();
  const ratio = renderer.getPixelRatio();
  const { height } = size();
  const px = toPixels(point);
  const x = Math.round(px.x * ratio) - 3, y = Math.round((height - px.y) * ratio) - 3;
  const data = new Uint8Array(7 * 7 * 4);
  gl.readPixels(x, y, 7, 7, gl.RGBA, gl.UNSIGNED_BYTE, data);
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2];
    n++;
  }
  if (!n) return null;
  return '#' + sum.map((value) => Math.round(value / n).toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- фигурка

// Отдельный рендерер для картинок: фигурка и вещи на карточках находок
let spriteRenderer = null;
const spriteScene = new THREE.Scene();
addLights(spriteScene, ROOM);
const spriteCamera = new THREE.OrthographicCamera();

function getSpriteRenderer() {
  if (!spriteRenderer) {
    spriteRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    spriteRenderer.setPixelRatio(1);
    spriteRenderer.setClearColor(0x000000, 0);
    spriteRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    spriteRenderer.toneMappingExposure = 1.1;
  }
  return spriteRenderer;
}

function lookFromCode(code) {
  if (!kit) return null;
  let codes = null;
  try {
    codes = code ? decodeLook(code) : null;
  } catch (error) {
    tell({ type: 'error', message: `код образа: ${error.message}` });
  }
  return kit.wardrobe.lookFromCodes(codes);
}

// Коробка, в которую влезает фигурка с любым головным убором: картинки
// всех игроков одного размера, а ноги всегда в одной и той же точке
const FIGURE_BOX = { r: 0.55, top: 2.5 };

// Рисует объект камерой того же направления, что у комнаты, и в том же
// масштабе. frame - какую часть мира показать: {center, points}
function renderFrame(object, points, ppu) {
  const r = getSpriteRenderer();
  const center = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
  spriteCamera.position.copy(center).addScaledVector(VIEW_DIRECTION, 40);
  spriteCamera.lookAt(center);
  spriteCamera.updateMatrixWorld();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    const v = p.clone().applyMatrix4(spriteCamera.matrixWorldInverse);
    minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
  }
  const width = Math.ceil((maxX - minX) * ppu), height = Math.ceil((maxY - minY) * ppu);
  Object.assign(spriteCamera, { left: minX, right: minX + width / ppu, top: maxY, bottom: maxY - height / ppu, near: 0.1, far: 200 });
  spriteCamera.updateProjectionMatrix();
  r.setSize(width, height, false);
  spriteScene.add(object);
  r.render(spriteScene, spriteCamera);
  spriteScene.remove(object);
  const project = (p) => {
    const v = p.clone().applyMatrix4(spriteCamera.matrixWorldInverse);
    return { x: (v.x - spriteCamera.left) * ppu, y: (spriteCamera.top - v.y) * ppu };
  };
  return { url: r.domElement.toDataURL('image/png'), width, height, project };
}

function boxPoints(at, r, y0, y1) {
  const points = [];
  for (const dx of [-r, r]) for (const dz of [-r, r]) for (const y of [y0, y1]) points.push(new THREE.Vector3(at.x + dx, y, at.z + dz));
  return points;
}

// Картинки фигурки на все четыре стороны и ещё одна - с закрытыми глазами.
// Фигурка стоит там же, где будет стоять в комнате, - так и свет на ней тот же
// Картинки рисуются вдвое подробнее, чем нужно на экране, - так края
// глаже. Размеры в ответе - уже экранные, в пикселях рамки
const SPRITE_DETAIL = 2;

function figureSprites(look, at) {
  const model = kit.buildFigure(kit.wardrobe, look);
  model.position.copy(at);
  const points = boxPoints(at, FIGURE_BOX.r, -0.02, FIGURE_BOX.top);
  const result = {};
  for (const [side, angle] of Object.entries(kit.FACING)) {
    model.rotation.y = angle;
    const frame = renderFrame(model, points, pixelsPerUnit * SPRITE_DETAIL);
    const anchor = frame.project(at);
    result[side] = frame.url;
    result.width = frame.width / SPRITE_DETAIL;
    result.height = frame.height / SPRITE_DETAIL;
    result.anchor = { x: anchor.x / SPRITE_DETAIL, y: anchor.y / SPRITE_DETAIL };
  }
  model.rotation.y = kit.FACING.down;
  kit.setEyesClosed(model, true);
  const sleep = renderFrame(model, points, pixelsPerUnit * SPRITE_DETAIL);
  kit.setEyesClosed(model, false);
  result.sleep = sleep.url;
  const head = sleep.project(new THREE.Vector3(at.x, kit.FIGURE.headY, at.z));
  result.head = { x: head.x / SPRITE_DETAIL, y: head.y / SPRITE_DETAIL };
  result.blinks = model.userData.blinks !== false;
  const skin = kit.wardrobe.resolve(look).skin;
  result.skin = skin ? skin.color : '#eec1a0';
  return { sprites: result, model };
}

// Какую часть фигурки показать на карточке новой вещи: [низ, верх, полуширина], от пола
const OUTFIT_FRAMES = {
  headwear: [0.97, 2.37, 0.48], hair: [0.97, 2.22, 0.48], hair_color: [0.97, 2.17, 0.48],
  head_extra: [1.07, 2.52, 0.55], ears: [1.07, 2.32, 0.5],
  eyes: [1.07, 1.82, 0.42], mouth: [1.07, 1.82, 0.42], nose: [1.07, 1.82, 0.42], eye_color: [1.07, 1.82, 0.42],
  skin: [0.72, 1.92, 0.5], top: [0.57, 1.32, 0.5], bottom: [0.07, 0.87, 0.42], shoes: [-0.08, 0.42, 0.42],
  wings: [0.47, 1.87, 0.95], tail: [0.27, 1.37, 0.75],
};
// Хвост виден со спины - его показываем вполоборота сзади
const OUTFIT_TURN = { tail: kitFacing('up', 0.6) };

function kitFacing(side, extra = 0) {
  return kit ? kit.FACING[side] + extra : 0;
}

function outfitPicture(message) {
  const look = lookFromCode(message.look);
  const item = kit.wardrobe.byId.get(message.item);
  if (!look || !item) return null;
  look[item.slot] = item.id;
  const model = kit.buildFigure(kit.wardrobe, look);
  model.rotation.y = OUTFIT_TURN[item.slot] ?? kit.FACING.down;
  const [y0, y1, r] = OUTFIT_FRAMES[item.slot] || [0, 2.5, 0.6];
  // Около 160 точек по высоте - для карточки хватает с запасом
  const ppu = 160 / ((y1 - y0) * 0.84 + r);
  return renderFrame(model, boxPoints(new THREE.Vector3(), r, y0, y1), ppu).url;
}

// ---------------------------------------------------------------- подготовка и показ

function prepare(message) {
  target = message.target || null;
  showing = false;
  renderer.setAnimationLoop(null);
  const layout = build(message.room, message.theme);
  placeCamera();
  // Пустая комната без мебели - по ней меряем цвета
  renderer.render(scene, camera);
  const colors = {
    left: sampleColor(new THREE.Vector3(0, H * 0.55, S * 0.55)),
    right: sampleColor(new THREE.Vector3(S * 0.55, H * 0.55, 0)),
    floor: sampleColor(new THREE.Vector3(S * 0.62, 0, S * 0.62)),
  };
  renderer.clear();
  if (message.shop) {
    prepareShop(message, layout, colors);
    return;
  }
  const cell = findCell(layout);
  const at = cell ? new THREE.Vector3(cell.a + 0.5, 0, cell.b + 0.5) : new THREE.Vector3(S * 0.6, 0, S * 0.6);
  let sprites = null;
  const look = lookFromCode(message.look);
  if (look) {
    const made = figureSprites(look, at);
    sprites = made.sprites;
    figure = made.model;
    figure.visible = false;
    scene.add(figure);
  }
  tell({ type: 'prepared', token: message.token, colors, spot: toPixels(at), count: items.length, figure: sprites });
}

// Лавка: продавец за прилавком, персонаж у входа, товары по местам
function prepareShop(message, layout, colors) {
  const info = message.shop;
  shop = new Shop({ scene, layout, items, kit, size: S });
  const goods = info.goods || [];
  if (kit) {
    const npcLook = lookFromCode(info.npc);
    if (npcLook) shop.placeNpc(npcLook);
    const look = lookFromCode(message.look);
    if (look && shop.entrance) {
      figure = kit.buildFigure(kit.wardrobe, look);
      figure.visible = false;
      scene.add(figure);
      shop.placePlayer(figure);
    }
  }
  const types = new Map(catalog.items.map((type) => [type.id, type]));
  const inRoom = shop.display(goods, types);
  // Картинки товаров: одежда - на фигурке игрока, мебель - сама по себе
  const pictures = {};
  for (const good of goods) {
    if (good.kind === 'outfit') {
      if (kit) pictures[good.id] = outfitPicture({ look: message.look, item: good.id });
    }
  }
  const furniture = goods.filter((good) => good.kind !== 'outfit').map((good) => types.get(good.id)).filter(Boolean);
  if (furniture.length) Object.assign(pictures, makeThumbnails(furniture, buildModel, 128));
  const px = (point) => (point ? toPixels(point) : null);
  const customer = shop.customerCell ? new THREE.Vector3(shop.customerCell.a + 0.5, 0, shop.customerCell.b + 0.5) : null;
  const npcPoints = shop.npc ? figurePoints(shop.npc, kit.FIGURE.headY) : null;
  const steps = Math.max(0, shop.path.length - 1);
  tell({
    type: 'prepared', token: message.token, colors, count: items.length, figure: null,
    spot: toPixels(shop.entrance ? new THREE.Vector3(shop.entrance.a + 0.5, 0, shop.entrance.b + 0.5) : new THREE.Vector3(S * 0.6, 0, S * 0.6)),
    shop: {
      customer: px(customer),
      customerHead: px(customer && new THREE.Vector3(customer.x, kit ? kit.FIGURE.headY : 1.5, customer.z)),
      npcHead: npcPoints && px(npcPoints.head),
      npcHands: npcPoints && px(npcPoints.hands),
      steps,
      hopMs: shop.hopMs(steps),
      gapMs: SHOP_HOP_GAP_MS,
      tags: inRoom ? shop.tagPoints().map(px) : null,
      pictures,
    },
  });
}

function show() {
  if (showing) return;
  showing = true;
  const start = performance.now() + 150;
  items.forEach((item, index) => {
    item.obj.visible = !item.hidden;
    item.appearAt = start + index * 70;
  });
  if (shop) shop.showGoods(lastSold);
  // Фигурка уже стоит - виджет показывал её картинкой ровно на этом месте
  if (figure) figure.visible = true;
  clock.getDelta();
  shownAt = clock.elapsedTime;
  renderer.setAnimationLoop(frame);
}

function hide() {
  showing = false;
  renderer.setAnimationLoop(null);
  clearItems();
  renderer.clear();
}

// ---------------------------------------------------------------- кадр

const clock = new THREE.Clock();
const blinker = kit ? new kit.Blinker() : null;
let shownAt = 0;
let lastSold = [];   // какие товары лавки уже проданы - когда рамку готовят заново посреди покупок
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  if (shop) shop.update(dt, time);
  if (figure) {
    // Фигурка дышит и моргает. Дыхание начинается с обычного роста - ровно
    // таким картинка фигурки была в виджете за миг до этого
    kit.breathe(figure, time - shownAt);
    blinker.update(figure, time);
  }
  for (const item of items) {
    springScale(item, dt);
    item.glows.forEach((glow, i) => {
      glow.material.opacity = glow.userData.glow.base * (0.88 + 0.12 * Math.sin(time * 2.2 + item.uid + i));
    });
  }
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  placeCamera();
  if (showing) renderer.render(scene, camera);
});

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const message = event.data || {};
  try {
    if (message.type === 'prepare') {
      lastSold = (message.shop && message.shop.sold) || [];
      prepare(message);
    } else if (message.type === 'walk' && shop) shop.walk(message.to, message.instant);
    else if (message.type === 'react' && shop) shop.react(message.kind);
    else if (message.type === 'sell' && shop) shop.sell(message.index);
    else if (message.type === 'jump' && shop) shop.jump();
    else if (message.type === 'target') {
      // Виджет поменял размер - силуэт комнаты ложится на новое место
      target = message.target || target;
      placeCamera();
      if (showing) renderer.render(scene, camera);
    } else if (message.type === 'show') show();
    else if (message.type === 'hide') hide();
    else if (message.type === 'thumbs') {
      tell({ type: 'thumbs', urls: makeThumbnails(catalog.items, buildModel, 128) });
    } else if (message.type === 'outfit') {
      tell({ type: 'outfit', token: message.token, url: kit ? outfitPicture(message) : null });
    }
  } catch (error) {
    tell({ type: 'error', message: String(error.message || error) });
  }
});

if (embedded) {
  tell({ type: 'loaded', figure: Boolean(kit) });
} else {
  document.body.classList.add('alone');
  const params = new URLSearchParams(location.hash.slice(1));
  const layout = build(params.get('r'));
  placeCamera();
  const look = params.has('l') ? lookFromCode(params.get('l')) : null;
  if (look) {
    const cell = findCell(layout);
    figure = kit.buildFigure(kit.wardrobe, look);
    figure.position.set(cell.a + 0.5, 0, cell.b + 0.5);
    figure.rotation.y = kit.FACING.down;
    scene.add(figure);
  }
  show();
}
window.__roomReady = true;
