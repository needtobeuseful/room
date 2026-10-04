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
//       для карточки находки: {type: 'outfit', token, url};
//   {type: 'sleep', seconds} - фигурка закрывает глаза и спит (отдых в
//       чужой комнате);
//   {type: 'fake', kind, ...} - чужая комната оказалась подделкой подвала:
//       kind: 'double' (owner - образ хозяина) - из лужи тьмы встаёт хозяин,
//           оборачивается с горящими глазами, проваливается и встаёт уже
//           копией игрока - и выталкивает его из комнаты;
//       kind: 'hungry', stage: 'on' | 'chomp' | 'off' (instant - сразу) -
//           голодная комната: свет красный и дышит, пол - язык; chomp -
//           укус, всё подпрыгивает;
//       kind: 'forgotten', stage: 'tear', item: {id, kind} - обрывки чужих
//           комнат: мебель гаснет, на стенах и полу лоскуты чужих обоев,
//           призраки чужой мебели, на полу светится забытая вещь. В ответ
//           {type: 'fake_point', point} - где она; stage: 'take' - вещь забрали.
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
//   {type: 'jump'} - персонаж подпрыгивает на месте (и в лавке, и в комнате).
// Сама страница присылает {type: 'loaded', figure: есть ли фигурки},
// а если что-то сломалось - {type: 'error', message}.
//
// Открытая напрямую (не в рамке), страница просто показывает комнату
// из ссылки: view.html#r=КОМНАТА&l=ОБРАЗ (или в рамке, но с &alone=1).

import * as THREE from 'three';
import { addLights, buildRoom, fitCamera, poseFor, springScale, themeOf, VIEW_DIRECTION } from './room.js';
import { figurePoints, Shop, SHOP_HOP_GAP_MS } from './shop.js';
import { buildModel } from './models.js';
import { Layout } from './layout.js';
import { applyFinish, finishesOf, floorTexture, isFinish, wallTexture } from './finish.js';
import { decodeLook, decodeRoom } from './codec.js';
import { makeThumbnails } from './thumbs.js';

// В рамке страница ждёт команд виджета. С alone в ссылке (view.html#r=...&alone=1)
// она просто показывает комнату и в рамке - так её встраивает страница «Игроки»
const embedded = window.parent !== window && !new URLSearchParams(location.hash.slice(1)).has('alone');
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
  eyes: [1.07, 1.82, 0.42], nose: [1.07, 1.82, 0.42], eye_color: [1.07, 1.82, 0.42],
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
  fakeReset();
  const layout = build(message.room, message.theme);
  lastLayout = layout;
  lastLook = message.look || '';
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
  fakeReset();
  clearItems();
  renderer.clear();
}

// ---------------------------------------------------------------- кадр

const clock = new THREE.Clock();
const blinker = kit ? new kit.Blinker() : null;
let shownAt = 0;
let lastSold = [];   // какие товары лавки уже проданы - когда рамку готовят заново посреди покупок
let sleepUntil = 0;  // до какого времени фигурка спит с закрытыми глазами
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  if (shop) shop.update(dt, time);
  if (figure && !figureHeld) {
    // Фигурка дышит и моргает. Дыхание начинается с обычного роста - ровно
    // таким картинка фигурки была в виджете за миг до этого
    kit.breathe(figure, time - shownAt);
    if (time < sleepUntil) kit.setEyesClosed(figure, true);
    else blinker.update(figure, time);
  }
  // Ложная комната - поверх дыхания: её анимации главнее
  if (fakeSteps.length) fakeSteps = fakeSteps.filter((step) => step(time) !== false);
  for (const item of items) {
    springScale(item, dt);
    item.glows.forEach((glow, i) => {
      glow.material.opacity = glow.userData.glow.base * (0.88 + 0.12 * Math.sin(time * 2.2 + item.uid + i));
    });
  }
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- ложные комнаты

// Подделка подвала притворяется чужой комнатой - виджет показывает её в
// рамке чужой комнаты, а здесь, в 3D, происходит то, чем она себя выдаёт
// (сообщение 'fake', см. начало файла). Всё, что подделка добавила в
// сцену, и весь изменённый свет убираются при 'hide' и новой 'prepare'.

const VIOLET = new THREE.Color('#b26bff');
const SHADOW = new THREE.Color('#1b1030');
const BLOOD = new THREE.Color('#ff3b4e');
const COLD = new THREE.Color('#b9c8ff');
const FLOOR_PROBE = { surface: 'floor', w: 1, d: 1, height: 1, name: '' };

// Свет комнаты, каким он был, - его приглушают и подкрашивают
const baseLights = [];
scene.traverse((o) => {
  if (o.isLight) baseLights.push({ light: o, intensity: o.intensity, color: o.color.clone() });
});

let lastLayout = null;   // расстановка мебели в комнате - где свободно
let lastLook = '';       // код образа игрока - двойник станет его копией
let fakeSteps = [];      // что подделка анимирует сейчас: step(time) -> false, когда всё
let fakeExtras = [];     // что она добавила в сцену
let fakeTints = new Map();   // материалы комнаты, которые она перекрасила: material -> исходный цвет
let figureHeld = false;  // фигуркой игрока сейчас управляет подделка: не дышать за неё
const fakeState = { mood: null, hungry: null, item: null };

const clamp01 = (k) => Math.max(0, Math.min(1, k));
const smooth = (k) => { k = clamp01(k); return k * k * (3 - 2 * k); };
const easeOut = (k) => 1 - Math.pow(1 - clamp01(k), 3);
const easeIn = (k) => Math.pow(clamp01(k), 3);
// С перелётом: чуть выше цели и обратно - как фишка, которую ставят на доску
const easeBack = (k) => { k = clamp01(k); const c = 1.9; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); };
const span = (t, from, to) => clamp01((t - from) / (to - from));

function fakeAdd(object) {
  scene.add(object);
  fakeExtras.push(object);
  return object;
}

function fakeStep(step) {
  fakeSteps.push(step);
}

// Свет: dim - во сколько раз приглушить, tint - чем подкрасить, k - насколько
// (0 - как было), mix - насколько сильно подкрашивать
function setMood(dim, tint, k, mix = 0.7) {
  for (const { light, intensity, color } of baseLights) {
    light.intensity = intensity * (1 - (1 - dim) * k);
    light.color.copy(color).lerp(tint, mix * k);
  }
}

// Стены и пол: walls - к какому цвету тянуть стены, floor - пол, k - насколько
function tintRoom(walls, floor, k) {
  room.group.traverse((o) => {
    if (!o.isMesh || !o.material || !o.material.color) return;
    const material = o.material;
    if (!fakeTints.has(material)) fakeTints.set(material, material.color.clone());
    const base = fakeTints.get(material);
    const isFloor = Boolean(material.map) && Math.abs(o.rotation.x + Math.PI / 2) < 0.01;
    material.color.copy(base).lerp(isFloor ? floor : walls, isFloor ? k : k * 0.55);
  });
}

function fakeReset() {
  fakeSteps = [];
  for (const object of fakeExtras) scene.remove(object);
  fakeExtras = [];
  for (const [material, color] of fakeTints) material.color.copy(color);
  fakeTints = new Map();
  setMood(1, VIOLET, 0);
  figureHeld = false;
  fakeState.mood = null;
  fakeState.hungry = null;
  fakeState.item = null;
}

// Свободная клетка пола по оценке score(a, b) - чем меньше, тем лучше
function bestCell(score) {
  let best = null;
  for (let a = 0; a < S; a++) {
    for (let b = 0; b < S; b++) {
      if (lastLayout && !lastLayout.check(FLOOR_PROBE, { surface: 'floor', a, b, rot: 0 }).ok) continue;
      const value = score(a, b);
      if (value == null) continue;
      if (!best || value < best.value) best = { a, b, value };
    }
  }
  return best;
}

function figureCell() {
  return figure ? { a: figure.position.x - 0.5, b: figure.position.z - 0.5 } : { a: S * 0.6, b: S * 0.6 };
}

// Куда повернуться, чтобы смотреть из from на to
function facingTo(from, to) {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

function turnAngle(a0, a1, k) {
  let d = a1 - a0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a0 + d * k;
}

// Картинка на холсте - текстурой
function canvasTexture(size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// Лужа тьмы на полу: из неё встаёт двойник
let puddleTexture = null;
function makePuddle(at) {
  puddleTexture = puddleTexture || canvasTexture(256, (ctx, size) => {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(6, 2, 14, 0.98)');
    g.addColorStop(0.5, 'rgba(24, 8, 46, 0.95)');
    g.addColorStop(0.78, 'rgba(110, 50, 200, 0.75)');
    g.addColorStop(0.9, 'rgba(190, 130, 255, 0.45)');
    g.addColorStop(1, 'rgba(190, 130, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  });
  const puddle = new THREE.Mesh(new THREE.CircleGeometry(0.85, 48),
    new THREE.MeshBasicMaterial({ map: puddleTexture, transparent: true, depthWrite: false }));
  puddle.rotation.x = -Math.PI / 2;
  puddle.position.set(at.x, 0.014, at.z);
  puddle.renderOrder = 2;
  puddle.scale.setScalar(0.001);
  return fakeAdd(puddle);
}

// Фиолетовые искры поднимаются из лужи
function makeWisps(at, count = 10) {
  const group = fakeAdd(new THREE.Group());
  const geometry = new THREE.SphereGeometry(0.05, 8, 6);
  for (let i = 0; i < count; i++) {
    const wisp = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: i % 3 ? 0xb47cff : 0xe2c8ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    wisp.userData = { phase: Math.random(), angle: Math.random() * Math.PI * 2, r: 0.2 + Math.random() * 0.5, speed: 0.7 + Math.random() * 0.6 };
    group.add(wisp);
  }
  group.position.set(at.x, 0, at.z);
  // power 0..1 - насколько густо они летят
  return (time, power) => {
    for (const wisp of group.children) {
      const u = wisp.userData;
      const k = (time * u.speed + u.phase) % 1;
      wisp.position.set(Math.cos(u.angle + k * 2) * u.r * (1 - k * 0.5), k * 2.2, Math.sin(u.angle + k * 2) * u.r * (1 - k * 0.5));
      wisp.material.opacity = power * Math.sin(k * Math.PI) * 0.9;
      wisp.scale.setScalar(1.4 - k);
    }
  };
}

// Двойник встаёт из пола: всё, что ниже пола, не рисуется - иначе ноги
// торчали бы из-под комнаты. Материалы - копии: они общие с игроком
const FLOOR_CLIP = [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)];
renderer.localClippingEnabled = true;

function underFloor(model) {
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = o.material.clone();
    o.material.clippingPlanes = FLOOR_CLIP;
  });
  return model;
}

// Фигурка-тень: темнее и с фиолетовым отливом
function shadowCopy(model) {
  underFloor(model);
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    if (o.material.color) o.material.color.lerp(SHADOW, 0.62);
    if (o.material.emissive) {
      o.material.emissive.copy(VIOLET);
      o.material.emissiveIntensity = 0.1;
    }
  });
  model.userData.blinks = false;
  return model;
}

// Свет у глаз двойника
function eyeLight(model) {
  const light = new THREE.PointLight(0xb26bff, 0, 2.6, 1.6);
  light.position.set(0, kit.FIGURE.headY, 0.45);
  model.add(light);
  return light;
}

// ---- двойник: всё - за DOUBLE_MS (то же - в obs_widgets/minimap/app.js)
const DOUBLE_MS = 4600;

function fakeDouble(message) {
  if (!kit || !figure) return;
  const start = clock.elapsedTime;
  const me = figureCell();
  // Двойник встаёт сбоку от игрока и чуть позади: на экране они рядом и
  // не заслоняют друг друга (по экрану вбок - это a - b, вглубь - a + b)
  const cell = bestCell((a, b) => {
    const d = Math.hypot(a - me.a, b - me.b);
    const side = Math.abs((a - b) - (me.a - me.b));
    const behind = (me.a + me.b) - (a + b);
    if (d < 2 || d > 4.2 || side < 2.4 || behind < -1) return null;
    return Math.abs(d - 3) + Math.abs(behind - 0.8) * 0.4 + (a === 0 || b === 0 ? 0.6 : 0);
  }) || bestCell((a, b) => {
    const d = Math.hypot(a - me.a, b - me.b);
    return d < 1.8 || d > 4.5 ? null : Math.abs(d - 2.8);
  });
  const at = cell
    ? new THREE.Vector3(cell.a + 0.5, 0, cell.b + 0.5)
    : new THREE.Vector3(Math.max(0.5, me.a - 1.5), 0, Math.max(0.5, me.b - 1.5));
  const ownerLook = lookFromCode(message.owner || '') || kit.wardrobe.defaultLook();
  const copyLook = lookFromCode(lastLook) || kit.wardrobe.defaultLook();
  const puddle = makePuddle(at);
  const wisps = makeWisps(at);
  let model = fakeAdd(underFloor(kit.buildFigure(kit.wardrobe, ownerLook)));
  model.rotation.order = 'YXZ';
  model.position.set(at.x, -2.3, at.z);
  let light = eyeLight(model);
  const player = figure.position.clone();
  const playerTurn = figure.rotation.y;
  const toward = facingTo(at, player);
  // Встаёт спиной к зрителю, оборачивается - и смотрит прямо на зрителя
  const away = kit.FACING.up;
  const viewer = kit.FACING.down;
  const lookAtDouble = facingTo(player, at);
  model.rotation.y = away;
  const dir = new THREE.Vector3().subVectors(player, at).setY(0).normalize();
  const stop = player.clone().addScaledVector(dir, -0.78);
  const lunge = stop.clone().addScaledVector(dir, 0.3);
  // Вторая лужа - под двойником после толчка: в неё он и уходит
  const puddle2 = makePuddle(lunge);
  let copied = false;
  const glow = (m, k) => {
    kit.setEyesGlow(m, VIOLET, 2.6 * k);
    light.intensity = 3.2 * k;
  };
  figureHeld = true;
  figure.rotation.order = 'YXZ';
  fakeState.mood = { dim: 0.5, tint: VIOLET, k: 0 };

  fakeStep((time) => {
    const t = (time - start) * 1000;
    // Свет гаснет, пока всё не кончится
    const mood = smooth(t / 600) * (1 - smooth((t - 4000) / 600));
    setMood(0.5, VIOLET, mood);
    // Лужа расползается, потом стягивается
    const size = easeOut(t / 420) * (1 - smooth((t - 3000) / 450));
    puddle.scale.setScalar(Math.max(0.001, size * (1 + 0.04 * Math.sin(t / 140))));
    puddle.rotation.z = t / 900;
    const size2 = easeOut(span(t, 3600, 3850)) * (1 - smooth((t - 4250) / 300));
    puddle2.scale.setScalar(Math.max(0.001, size2 * 0.85));
    puddle2.rotation.z = -t / 900;
    wisps(time, smooth((t - 100) / 400) * (1 - smooth((t - 2500) / 400)));

    if (!copied) {
      // Хозяин поднимается из лужи - спиной к игроку
      if (t < 2000) {
        model.position.y = -2.3 + 2.3 * easeBack(span(t, 150, 800));
        model.rotation.z = Math.sin(t / 260) * 0.03 * (1 - span(t, 800, 1200));
      }
      // ...медленно оборачивается к зрителю, глаза наливаются фиолетовым
      model.rotation.y = turnAngle(away, viewer, smooth(span(t, 800, 1700)));
      glow(model, span(t, 1000, 1700) * (t > 1700 ? 0.85 + 0.25 * Math.sin(t / 55) : 1));
      // ...смотрит, наклонив голову набок
      if (t > 1700) model.rotation.z = 0.13 * smooth(span(t, 1700, 1900));
      // ...и проваливается обратно
      if (t > 2000) {
        const k = easeIn(span(t, 2000, 2250));
        model.position.y = -2.3 * k;
        model.scale.set(1 + 0.12 * k, 1 - 0.1 * k, 1 + 0.12 * k);
      }
      if (t >= 2250) {
        // Встаёт уже копией игрока: тёмной, с горящими глазами
        scene.remove(model);
        model = fakeAdd(shadowCopy(kit.buildFigure(kit.wardrobe, copyLook)));
        model.rotation.order = 'YXZ';
        model.rotation.y = viewer;
        model.position.set(at.x, -2.3, at.z);
        light = eyeLight(model);
        copied = true;
      }
    }
    if (copied) {
      if (t < 2750) {
        // Встаёт копией игрока - лицом к зрителю - и поворачивается к игроку
        const k = span(t, 2250, 2600);
        model.position.y = -2.3 + 2.3 * easeBack(k);
        const over = Math.sin(k * Math.PI) * 0.12;
        model.scale.set(1 - over * 0.5, 1 + over, 1 - over * 0.5);
        model.rotation.y = turnAngle(viewer, toward, smooth(span(t, 2600, 2750)));
        glow(model, 1.2);
      } else if (t < 3150) {
        // Подходит двумя прыжками, как фишка
        model.scale.setScalar(1);
        const k = span(t, 2750, 3150);
        const hop = k < 0.5 ? k / 0.5 : (k - 0.5) / 0.5;
        const along = (k < 0.5 ? 0 : 0.5) + smooth(hop) * 0.5;
        model.position.lerpVectors(at, stop, along);
        model.position.y = Math.sin(Math.PI * hop) * 0.32;
        model.rotation.y = facingTo(model.position, player);
        model.rotation.x = Math.sin(Math.PI * hop) * 0.1;
        glow(model, 1);
      } else if (t < 3300) {
        // Замах: откидывается назад
        model.position.copy(stop);
        model.rotation.x = -0.32 * smooth(span(t, 3150, 3300));
      } else if (t < 3500) {
        // Толчок: всем телом вперёд
        const k = span(t, 3300, 3420);
        model.position.lerpVectors(stop, lunge, easeOut(k));
        model.rotation.x = -0.32 + 0.78 * easeOut(k);
        glow(model, 1.3);
      } else if (t < 3800) {
        // Выпрямляется и поворачивается к зрителю - глаза вспыхивают
        const k = smooth(span(t, 3500, 3800));
        model.rotation.x = 0.46 * (1 - k);
        model.rotation.y = turnAngle(facingTo(model.position, player), kit.FACING.down, k);
        model.position.y = Math.abs(Math.sin(span(t, 3550, 3800) * Math.PI * 2)) * 0.12;
        glow(model, 1 + 1.4 * Math.sin(k * Math.PI));
      } else {
        // ...и уходит в лужу у себя под ногами
        const k = easeIn(span(t, 3850, 4300));
        model.position.set(lunge.x, -2.3 * k, lunge.z);
        model.rotation.x = 0;
        glow(model, 1 - k * 0.5);
      }
    }

    // Игрок: оборачивается на двойника, дрожит, когда видит свою копию, и улетает
    if (t < 3350) {
      figure.rotation.y = turnAngle(playerTurn, lookAtDouble, smooth(span(t, 500, 800)));
      const shiver = t > 2250 && t < 2700 ? Math.sin(t / 18) * 0.035 * (1 - span(t, 2250, 2700)) : 0;
      figure.position.copy(player).addScaledVector(new THREE.Vector3(dir.z, 0, -dir.x), shiver);
      // Отшатывается, когда двойник подходит
      figure.rotation.x = -0.12 * smooth(span(t, 2900, 3300));
    } else if (t < 4100) {
      const q = span(t, 3350, 4050);
      figure.position.copy(player).addScaledVector(dir, 1.9 * easeOut(q));
      figure.position.y = 11 * (1 - Math.pow(1 - q, 2));
      figure.rotation.x = -0.12 - q * 7.5;
      figure.rotation.z = q * 2.2;
      figure.scale.setScalar(1);
    } else {
      figure.visible = false;
    }
    return t < DOUBLE_MS;
  });
}

// ---- голодная комната

// Голодная комната: свет краснеет и пульсирует, стены темнеют, пол - как
// язык. chomp - укус: мебель и игрок подпрыгивают
function fakeHungry(message) {
  if (message.stage === 'chomp') {
    for (const item of items) item.scaleSpeed -= 2.6 + Math.random();
    if (figure) {
      const start = clock.elapsedTime;
      fakeStep((time) => {
        const k = (time - start) / 0.32;
        if (k >= 1 || !figure) return false;
        const s = Math.sin(k * Math.PI) * 0.14;
        figure.scale.set(1 + s * 0.6, 1 - s, 1 + s * 0.6);
        return true;
      });
    }
    return;
  }
  const on = message.stage === 'on';
  if (!fakeState.hungry) {
    const light = fakeAdd(new THREE.PointLight(0xff3040, 0, 14, 1.5));
    light.position.set(S * 0.5, H * 0.75, S * 0.5);
    fakeState.hungry = { k: 0, target: 0, light, last: clock.elapsedTime, shiverUntil: 0 };
    const hungry = fakeState.hungry;
    fakeStep((time) => {
      if (fakeState.hungry !== hungry) return false;
      const dt = Math.min(0.05, time - hungry.last);
      hungry.last = time;
      hungry.k += Math.sign(hungry.target - hungry.k) * Math.min(Math.abs(hungry.target - hungry.k), dt * 2.4);
      const k = hungry.k;
      // Свет «дышит», как живое: вдох - ярче
      const breath = 0.85 + 0.15 * Math.sin(time * 3.4);
      setMood(0.6, BLOOD, k);
      tintRoom(new THREE.Color('#4a0a18'), new THREE.Color('#ff8e9c'), k);
      light.intensity = 9 * k * breath;
      if (figure && time < hungry.shiverUntil) {
        figure.position.x = hungry.x + Math.sin(time * 70) * 0.025;
      } else if (figure && hungry.x != null) {
        figure.position.x = hungry.x;
        hungry.x = null;
      }
      return true;
    });
  }
  const hungry = fakeState.hungry;
  hungry.target = on ? 1 : 0;
  // Игроку страшно: дрожит
  if (on && figure) {
    hungry.x = figure.position.x;
    hungry.shiverUntil = clock.elapsedTime + (message.instant ? 0 : 0.7);
  }
  if (message.instant) hungry.k = hungry.target;
}

// ---- обрывки чужих комнат

// Рваный лоскут: кусок обоев с неровными, будто оторванными краями -
// почти прямоугольный, уголки загнуты внутрь по-разному
function tornShape(r, seed) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const w = r * 1.25, h = r * 0.95;
  const corners = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => [x * (0.8 + rnd() * 0.22), y * (0.8 + rnd() * 0.22)]);
  const points = [];
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i], [x1, y1] = corners[(i + 1) % 4];
    const len = Math.hypot(x1 - x0, y1 - y0), nx = -(y1 - y0) / len, ny = (x1 - x0) / len;
    for (let j = 0; j < 9; j++) {
      const k = j / 9;
      const jag = (rnd() - 0.5) * r * (j % 2 ? 0.2 : 0.08);
      points.push([x0 + (x1 - x0) * k + nx * jag, y0 + (y1 - y0) * k + ny * jag]);
    }
  }
  const shape = new THREE.Shape();
  points.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const geometry = new THREE.ShapeGeometry(shape);
  // Картинка ложится на лоскут целиком
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const position = geometry.attributes.position, uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, (position.getX(i) - min.x) / (max.x - min.x), (position.getY(i) - min.y) / (max.y - min.y));
  }
  return geometry;
}

// Лоскут чужих обоев или пола: картинка и бумажный край под ней
function makeScrap(type, plane, u, v, r, seed) {
  const theme = applyFinish(themeOf(catalog, null), type);
  const wall = type.surface === 'wallpaper';
  const tiles = Math.max(1, Math.round((r * 2.3) / 1.4 * 2) / 2);
  const map = wall
    ? wallTexture(theme, { background: plane === 'left' ? theme.wallLeft : theme.wallRight, repeat: [tiles, tiles] })
    : floorTexture(theme, 2);
  const group = new THREE.Group();
  // Бумажный край: чуть больше картинки и оторван по-своему - белеет местами
  const edge = new THREE.Mesh(tornShape(r * 1.1, seed + 7), new THREE.MeshStandardMaterial({
    color: 0xf6eedd, roughness: 0.95, transparent: true, opacity: 0, depthWrite: false,
  }));
  const face = new THREE.Mesh(tornShape(r, seed), new THREE.MeshStandardMaterial({
    map, roughness: 0.9, transparent: true, opacity: 0, depthWrite: false,
  }));
  face.position.z = 0.004;
  // Прозрачное three.js сортирует по середине фигуры, а у края и картинки
  // она разная - порядок задаём сами: сначала край, поверх картинка
  edge.renderOrder = 2;
  face.renderOrder = 3;
  group.add(edge, face);
  group.rotation.z = (Math.random() - 0.5) * 0.5;
  if (plane === 'left') {
    group.position.set(0.016, v, u);
    group.rotation.y = Math.PI / 2;
  } else if (plane === 'right') {
    group.position.set(u, v, 0.016);
  } else {
    group.position.set(u, 0.01, v);
    group.rotation.x = -Math.PI / 2;
  }
  group.scale.setScalar(0.001);
  group.userData.materials = [edge.material, face.material];
  return fakeAdd(group);
}

// Призрак чужой мебели: полупрозрачный, голубоватый, мерцает
function makeGhost(type, at) {
  const model = buildModel(type);
  model.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity = 0;
    o.material.depthWrite = false;
    if (o.material.color) o.material.color.lerp(new THREE.Color('#cfe8ff'), 0.55);
    if (o.material.emissive) {
      o.material.emissive.set('#5f8dff');
      o.material.emissiveIntensity = 0.35;
    }
    o.castShadow = false;
  });
  model.position.set(at.x, 0, at.z);
  model.rotation.y = Math.floor(Math.random() * 4) * Math.PI / 2;
  const materials = [];
  model.traverse((o) => { if (o.isMesh) materials.push(o.material); });
  model.userData.materials = materials;
  return fakeAdd(model);
}

// Забытая вещь: мебель (или обои, пол) - модель, одежда - манекен в ней.
// Вписана в клетку пола и светится золотом
function makeForgotten(item, at) {
  let model = null;
  if (item.kind === 'outfit' && kit) {
    model = kit.buildMannequin(kit.wardrobe, item.id);
    model.scale.setScalar(0.62);
  } else {
    const type = catalog.items.find((x) => x.id === item.id);
    if (type) {
      model = buildModel(type);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const k = Math.min(1, 1.15 / Math.max(size.x, size.z, size.y * 0.6));
      model.scale.setScalar(k);
      model.userData.lift = -box.min.y * k;
    }
  }
  const holder = fakeAdd(new THREE.Group());
  holder.position.set(at.x, 0, at.z);
  holder.rotation.y = kit ? kit.FACING.down : Math.PI / 4;
  if (model) {
    model.position.y = model.userData.lift || 0;
    holder.add(model);
  }
  const light = new THREE.PointLight(0xffd36b, 0, 3.2, 1.4);
  light.position.set(0, 1.1, 0);
  holder.add(light);
  holder.userData.light = light;
  holder.userData.base = model ? model.scale.x : 1;
  holder.userData.model = model;
  holder.scale.setScalar(0.001);
  return holder;
}

// Обрывки чужих комнат: мебель хозяина гаснет, по стенам и полу - лоскуты
// чужих обоев и пола, мелькают призраки чужой мебели, на полу светится
// забытая вещь. Отвечает, где она: {type: 'fake_point', point}
function fakeForgotten(message) {
  if (message.stage === 'take') {
    if (fakeState.item) fakeState.item.userData.taken = clock.elapsedTime;
    return;
  }
  if (message.stage === 'jump') {
    figureJump();
    return;
  }
  const start = clock.elapsedTime;
  const me = figureCell();
  // Мебель хозяина мигает и гаснет - по очереди
  items.forEach((item, i) => {
    item.flickerAt = start + 0.05 + Math.random() * 0.25;
    item.goneAt = item.flickerAt + 0.35 + i * 0.03 + Math.random() * 0.2;
  });
  // Лоскуты: настоящие обои и полы из каталога - все разные, пока хватает
  const finishes = catalog.items.filter((type) => isFinish(type));
  const decks = {};
  const pick = (surface) => {
    if (!decks[surface] || !decks[surface].length) {
      decks[surface] = finishes.filter((type) => type.surface === surface).sort(() => Math.random() - 0.5);
    }
    return decks[surface].pop();
  };
  const scraps = [];
  const spots = [
    ['left', 0.24, 0.62], ['left', 0.68, 0.34], ['right', 0.3, 0.42], ['right', 0.74, 0.68],
    ['left', 0.5, 0.82], ['right', 0.52, 0.18], ['floor', 0.25, 0.3], ['floor', 0.7, 0.22], ['floor', 0.28, 0.72],
  ];
  spots.forEach(([plane, u, v], i) => {
    const type = pick(plane === 'floor' ? 'flooring' : 'wallpaper');
    if (!type) return;
    const r = plane === 'floor' ? 1.1 + Math.random() * 0.5 : 0.9 + Math.random() * 0.5;
    // На полу - не под ногами у игрока
    let fu = u * S, fv = plane === 'floor' ? v * S : v * H;
    if (plane === 'floor' && Math.hypot(fu - me.a - 0.5, fv - me.b - 0.5) < 1.6) { fu = S - fu; fv = S - fv; }
    const scrap = makeScrap(type, plane, fu, fv, r, 1234 + i * 977);
    scrap.userData.at = start + 0.25 + i * 0.09;
    scraps.push(scrap);
  });
  // Призраки чужой мебели - там, где у хозяина было пусто
  const furniture = catalog.items.filter((type) => type.surface === 'floor' && type.w <= 2 && (type.d || 1) <= 2 && !type.prefer);
  const ghostCells = [];
  for (let i = 0; i < 4 && furniture.length; i++) {
    const cell = bestCell((a, b) => {
      if (Math.hypot(a - me.a, b - me.b) < 2) return null;
      if (ghostCells.some((c) => Math.hypot(a - c.a, b - c.b) < 2.2)) return null;
      return Math.random();
    });
    if (!cell) break;
    ghostCells.push(cell);
  }
  const ghosts = ghostCells.map((cell, i) => {
    const ghost = makeGhost(furniture[Math.floor(Math.random() * furniture.length)], new THREE.Vector3(cell.a + 0.5, 0, cell.b + 0.5));
    ghost.userData.at = start + 0.45 + i * 0.18;
    ghost.userData.seed = Math.random() * 10;
    return ghost;
  });
  // Забытая вещь - на свободной клетке впереди, на виду, не вплотную к игроку
  const cell = bestCell((a, b) => {
    const d = Math.hypot(a - me.a, b - me.b);
    if (d < 1.4 || d > 3.6) return null;
    if (ghostCells.some((c) => Math.hypot(a - c.a, b - c.b) < 1.4)) return null;
    return Math.abs(d - 2.2) - (a + b) * 0.08 + Math.random() * 0.3;
  });
  const at = cell ? new THREE.Vector3(cell.a + 0.5, 0, cell.b + 0.5) : new THREE.Vector3(S * 0.4, 0, S * 0.7);
  const holder = makeForgotten(message.item || {}, at);
  fakeState.item = holder;
  const appearAt = start + 0.85;
  const playerTurn = figure ? figure.rotation.y : 0;
  const lookAt = figure ? facingTo(figure.position, at) : 0;
  if (figure) figureHeld = false;
  fakeState.mood = true;

  fakeStep((time) => {
    const t = time - start;
    // Свет становится холоднее и чуть тусклее - как в старом сне
    setMood(0.85, COLD, smooth(t / 0.6), 0.32);
    for (const item of items) {
      if (time < item.flickerAt) continue;
      if (time < item.goneAt) item.obj.visible = !item.hidden && Math.random() > 0.45;
      else if (!item.gone) {
        item.gone = true;
        item.obj.visible = !item.hidden;
        item.scaleTarget = 0.001;
        item.scaleSpeed = 1.5;
      }
    }
    for (const scrap of scraps) {
      const k = (time - scrap.userData.at) / 0.28;
      if (k < 0) continue;
      // Лоскут влетает с дрожью и мерцанием, потом чуть колышется
      const s = k < 1 ? easeBack(k) : 1 + Math.sin(time * 2 + scrap.userData.at * 9) * 0.015;
      scrap.scale.setScalar(Math.max(0.001, s));
      const flicker = k < 1.6 && Math.random() < 0.3 ? 0.35 : 1;
      for (const m of scrap.userData.materials) m.opacity = flicker * clamp01(k * 2);
    }
    for (const ghost of ghosts) {
      const k = time - ghost.userData.at;
      if (k < 0) continue;
      const wave = 0.46 + 0.14 * Math.sin(time * 5 + ghost.userData.seed) + (Math.random() < 0.06 ? -0.3 : 0);
      for (const m of ghost.userData.materials) m.opacity = Math.max(0, wave) * clamp01(k * 3);
      ghost.position.y = 0.06 + Math.sin(time * 1.6 + ghost.userData.seed) * 0.05;
    }
    // Вещь появляется, крутится и светится; забрали - уменьшается и гаснет
    const light = holder.userData.light;
    if (time > appearAt) {
      const k = time - appearAt;
      let s = easeBack(k / 0.45);
      if (holder.userData.taken) s *= 1 - easeIn((time - holder.userData.taken) / 0.35);
      holder.scale.setScalar(Math.max(0.001, s));
      holder.position.y = 0.12 + Math.sin(k * 3) * 0.07;
      holder.rotation.y += 0.012;
      light.intensity = (holder.userData.taken ? 0 : 1) * (4 + 2 * Math.sin(k * 6)) * clamp01(k * 2);
    }
    // Игрок оборачивается на блеск
    if (figure && !holder.userData.taken) figure.rotation.y = turnAngle(playerTurn, lookAt, smooth((t - 0.9) / 0.35));
    return true;
  });
  // Где блестит: чуть выше середины вещи
  const lift = holder.userData.model ? 0.55 : 0.4;
  tell({ type: 'fake_point', point: toPixels(new THREE.Vector3(at.x, lift, at.z)) });
}

// Игрок рад - подпрыгивает (забытая вещь, подарок дома)
function figureJump() {
  if (!figure) return;
  const start = clock.elapsedTime;
  const base = figure.position.y;
  fakeStep((time) => {
    const k = (time - start) / 0.45;
    if (k >= 1 || !figure) {
      if (figure) figure.position.y = base;
      return false;
    }
    figure.position.y = base + Math.sin(k * Math.PI) * 0.45;
    return true;
  });
}

function fakeMessage(message) {
  if (message.kind === 'double') fakeDouble(message);
  else if (message.kind === 'hungry') fakeHungry(message);
  else if (message.kind === 'forgotten') fakeForgotten(message);
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
    else if (message.type === 'jump') {
      if (shop) shop.jump();
      else if (showing) figureJump();
    }
    else if (message.type === 'sleep') sleepUntil = clock.elapsedTime + (message.seconds || 1.5);
    else if (message.type === 'fake' && showing) fakeMessage(message);
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
