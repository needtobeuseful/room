// Редактор комнаты: коллекция мебели зрителя и её расстановка.
//
// Ссылку на редактор присылает бот по команде !комната. После # в ней -
// один код (codec.js, encodeLink): ник зрителя, мебель из его коллекции,
// которой нет в комнате, и сама комната. Расставленное - тоже его: сайт
// прибавляет его к коллекции сам. Старые ссылки (#n=ник&i=коллекция&r=
// комната) тоже открываются. Всё после # браузер никуда не отправляет -
// страница читает это сама.
//
// Без коллекции редактор открывается в режиме каталога: вся мебель игры, без
// ограничений по количеству. Так собираются особые комнаты для мини-игры -
// например, лавки NPC: их готовые шаблоны (catalog.json → templates)
// выбираются вверху.
//
// Кроме мебели в коллекции - обои и пол (finish.js). Их не расставляют, а
// выбирают: обои в комнате одни, пол - один. В коде комнаты они записаны
// как предмет на полу в клетке (0, 0).
//
// Сама страница ничего не сохраняет. Зритель отправляет в чат
// «!комната КОД», и бот сам проверяет, что вся мебель - из его коллекции.

import * as THREE from 'three';
import { addLights, buildRoom, fitCamera, poseFor, springScale, themeOf } from './room.js';
import { FINISHES, isFinish } from './finish.js';
import { buildModel } from './models.js';
import { Layout, footprint } from './layout.js';
import { decodeInventory, decodeRoom, encodeLink, encodeRoom, LINK_ROOM, MAX_ITEMS, readLink } from './codec.js';
import { makeThumbnails } from './thumbs.js';

const $ = (selector) => document.querySelector(selector);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function plural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}
const ITEM_FORMS = ['предмет', 'предмета', 'предметов'];

const catalog = await fetch('catalog.json', { cache: 'no-cache' }).then((response) => {
  if (!response.ok) throw new Error(`catalog.json: ${response.status}`);
  return response.json();
});

const ROOM = catalog.room;
const S = ROOM.size;
const H = ROOM.wallHeight;
const RARITIES = catalog.rarities || {};
const SETS = catalog.sets || {};
const THEMES = catalog.themes || {};
const TEMPLATES = catalog.templates || {};
const typeById = new Map(catalog.items.map((type) => [type.id, type]));
const typeByCode = new Map(catalog.items.map((type) => [type.code, type]));

// ---------------------------------------------------------------- что пришло в ссылке

const incoming = readLink(location.hash);
const params = incoming.params || new URLSearchParams();
const linked = incoming.link && incoming.link.page === LINK_ROOM ? incoming.link : null;
const playerName = incoming.name;
const inventoryText = params.get('i');
const catalogMode = !incoming.link && !incoming.error && inventoryText === null;
let owned = new Map();         // номер предмета -> сколько штук в коллекции
const allOwned = new Map();    // то же вместе с мебелью, которой сайт ещё не знает, - для ссылки
let unknownOwned = 0;          // мебель, которой этот сайт ещё не знает
let brokenLink = '';

function own(code, count) {
  allOwned.set(code, (allOwned.get(code) || 0) + count);
  if (typeByCode.has(code)) owned.set(code, (owned.get(code) || 0) + count);
  else unknownOwned += count;
}

if (incoming.error || (incoming.link && !linked)) {
  brokenLink = `Ссылка повреждена (${incoming.error || 'это ссылка на другую страницу'}) - попроси у бота новую: !комната`;
} else if (linked) {
  for (const [code, count] of linked.inventory) own(code, count);
  for (const p of linked.room) own(p.code, 1);
} else if (!catalogMode) {
  try {
    for (const [code, count] of decodeInventory(inventoryText)) own(code, count);
  } catch (error) {
    brokenLink = `Ссылка повреждена (${error.message}) - попроси у бота новую: !комната`;
  }
}

// В режиме каталога видно всё, у зрителя - только его мебель
const types = catalog.items.filter((type) => catalogMode || owned.has(type.code));
const available = (type) => (catalogMode ? Infinity : (owned.get(type.code) || 0) - placedCount(type));

// ---------------------------------------------------------------- сцена

const stage = $('#stage');
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera();
let room = buildRoom(ROOM, themeOf(catalog, null));
scene.add(room.group);
addLights(scene, ROOM);

// Обои и пол комнаты: тип предмета из каталога или null - как в обычной комнате
const finish = { wallpaper: null, flooring: null };

function rebuildRoom() {
  const opacity = room.grid.material.opacity;
  scene.remove(room.group);
  room = buildRoom(ROOM, themeOf(catalog, null, FINISHES.map((surface) => finish[surface]).filter(Boolean)));
  room.grid.material.opacity = opacity;
  scene.add(room.group);
}

// Подсветка клеток под выбранным или перетаскиваемым предметом
const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x8b7bff, transparent: true, opacity: 0.3, depthWrite: false });
const marker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), markerMaterial);
const markerEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
  new THREE.LineBasicMaterial({ color: 0x8b7bff, transparent: true, opacity: 0.9 }));
marker.add(markerEdge);
marker.renderOrder = 8;
marker.visible = false;
scene.add(marker);

const MARKER_COLORS = { select: 0x8b7bff, ok: 0x4ade80, bad: 0xff5a6a };

function showMarker(type, p, mode) {
  const fp = footprint(type, p.rot);
  const inset = 0.06;
  if (p.surface === 'floor') {
    marker.rotation.set(-Math.PI / 2, 0, 0);
    marker.scale.set(fp.w - inset, fp.d - inset, 1);
    marker.position.set(p.a + fp.w / 2, type.surface === 'cover' ? 0.05 : 0.02, p.b + fp.d / 2);
  } else if (p.surface === 'left') {
    marker.rotation.set(0, Math.PI / 2, 0);
    marker.scale.set(fp.w - inset, fp.h - inset, 1);
    marker.position.set(0.02, p.b + fp.h / 2, p.a + fp.w / 2);
  } else {
    marker.rotation.set(0, 0, 0);
    marker.scale.set(fp.w - inset, fp.h - inset, 1);
    marker.position.set(p.a + fp.w / 2, p.b + fp.h / 2, 0.02);
  }
  markerMaterial.color.setHex(MARKER_COLORS[mode]);
  markerEdge.material.color.setHex(MARKER_COLORS[mode]);
  // Пока предмет тащат, клетки видны поверх мебели - иначе красную
  // подсветку «сюда нельзя» закрыло бы то, что мешает
  markerMaterial.depthTest = markerEdge.material.depthTest = mode === 'select';
  marker.visible = true;
}

// ---------------------------------------------------------------- предметы

const layout = new Layout(ROOM);
const leaving = [];   // убранные предметы, которые ещё доигрывают анимацию
let foreign = [];     // предметы из ссылки, которых этот сайт ещё не знает: их не видно, но они сохраняются
let uidCounter = 0;
let selected = null;
let drag = null;

function placedCount(type) {
  if (isFinish(type)) return finish[type.surface] === type ? 1 : 0;
  return layout.items.reduce((sum, item) => sum + (item.type === type ? 1 : 0), 0);
}

const finishCount = () => FINISHES.filter((surface) => finish[surface]).length;

function setTarget(item, p, lift = 0) {
  const pose = poseFor(item.type, p, lift);
  item.target.copy(pose.pos);
  item.targetRot = pose.rot;
}

function spawn(type, p, delay = 0) {
  const obj = buildModel(type);
  const item = {
    uid: ++uidCounter, type, surface: p.surface, a: p.a, b: p.b, rot: p.rot, obj,
    target: new THREE.Vector3(), targetRot: 0,
    scale: 0.01, scaleTarget: 1, scaleSpeed: 0, appearAt: performance.now() + delay * 1000, glows: [],
  };
  obj.traverse((o) => {
    o.userData.uid = item.uid;
    if (o.userData.glow) item.glows.push(o);
  });
  obj.scale.setScalar(0.01);
  setTarget(item, item);
  obj.position.copy(item.target);
  obj.rotation.y = item.targetRot;
  scene.add(obj);
  layout.add(item);
  return item;
}

function commit(item, p) {
  Object.assign(item, { surface: p.surface, a: p.a, b: p.b, rot: p.rot });
  setTarget(item, item);
  saveState();
}

// ---------------------------------------------------------------- из коллекции в комнату и обратно

function place(type) {
  if (drag) return;
  if (isFinish(type)) {
    // Выбранные обои или пол - нажал ещё раз, и комната снова обычная
    setFinish(type.surface, finish[type.surface] === type ? null : type);
    return;
  }
  if (layout.items.length + foreign.length + finishCount() >= MAX_ITEMS) {
    toast(`В комнате не больше ${MAX_ITEMS} предметов`);
    return;
  }
  if (available(type) <= 0) {
    // Всё уже стоит в комнате - покажем, где
    const placed = layout.items.filter((item) => item.type === type);
    const next = placed[(placed.indexOf(selected) + 1) % placed.length];
    if (next) select(next);
    toast(owned.get(type.code) > 1 ? `Все «${type.name}» уже в комнате` : `«${type.name}» уже в комнате`);
    return;
  }
  const spot = layout.findSpot(type);
  if (!spot) {
    toast(type.surface === 'wall' ? 'На стенах нет места' : 'На полу нет места');
    return;
  }
  select(spawn(type, spot));
  hideHint();
  saveState();
  refreshCollection();
}

// Обои или пол: type - из коллекции, null - как в обычной комнате
function setFinish(surface, type) {
  if (finish[surface] === type) return;
  if (type && available(type) <= 0) return;
  finish[surface] = type;
  rebuildRoom();
  hideHint();
  saveState();
  refreshCollection();
}

function removeSelected() {
  const item = selected;
  if (!item || drag) return;
  layout.remove(item);
  item.scaleTarget = 0;
  leaving.push(item);
  select(null);
  saveState();
  refreshCollection();
}

function rotateSelected() {
  const item = selected;
  if (!item || drag || item.type.surface === 'wall') return;
  const now = footprint(item.type, item.rot);
  const cx = item.a + now.w / 2, cz = item.b + now.d / 2;
  const rot = (item.rot + 1) % 4;
  const fp = footprint(item.type, rot);
  const baseA = Math.round(cx - fp.w / 2), baseB = Math.round(cz - fp.d / 2);
  // Если на месте не развернуться - пробуем чуть сдвинуть
  const shifts = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  for (const [da, db] of shifts) {
    const p = { surface: 'floor', rot, a: clamp(baseA + da, 0, S - fp.w), b: clamp(baseB + db, 0, S - fp.d) };
    if (layout.check(item.type, p, item.uid).ok) {
      commit(item, p);
      showMarker(item.type, item, 'select');
      return;
    }
  }
  toast('Не развернуть: мало места');
}

// ---------------------------------------------------------------- выбор и перетаскивание

const toolbar = $('#toolbar');

function select(item) {
  selected = item;
  if (!item) {
    marker.visible = false;
    toolbar.hidden = true;
    return;
  }
  showMarker(item.type, item, 'select');
  toolbar.hidden = false;
  $('#rotate').disabled = item.type.surface === 'wall';
  $('#toolbar-name').textContent = item.type.name;
}

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const wallPlanes = [
  ['left', new THREE.Plane(new THREE.Vector3(1, 0, 0), 0)],
  ['right', new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)],
];

function aim(event) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

function pickItem() {
  const hits = raycaster.intersectObjects(layout.items.map((item) => item.obj), true);
  for (const hit of hits) {
    if (hit.object.userData.glow) continue;
    const item = layout.byUid(hit.object.userData.uid);
    if (item) return item;
  }
  return null;
}

function floorPoint() {
  return raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
}

// Точка на той стене, которая видна под указателем
function wallPoint() {
  let best = null;
  for (const [surface, plane] of wallPlanes) {
    const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!point) continue;
    const along = surface === 'left' ? point.z : point.x;
    if (along < -0.3 || along > S + 0.3 || point.y < 0 || point.y > H + 0.5) continue;
    const distance = raycaster.ray.origin.distanceTo(point);
    if (!best || distance < best.distance) best = { surface, point, along, distance };
  }
  return best;
}

function beginDrag(item, event) {
  const fp = footprint(item.type, item.rot);
  const offset = { x: 0, z: 0 };
  if (item.type.surface !== 'wall') {
    const p = floorPoint();
    if (p) {
      offset.x = item.a + fp.w / 2 - p.x;
      offset.z = item.b + fp.d / 2 - p.z;
    }
  }
  drag = {
    item, offset, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false,
    cand: { surface: item.surface, a: item.a, b: item.b, rot: item.rot }, ok: true, reason: '',
  };
}

function moveDrag(event) {
  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
    drag.moved = true;
    canvas.style.cursor = 'grabbing';
    hideHint();
  }
  const { item } = drag;
  const type = item.type;
  let cand;
  if (type.surface === 'wall') {
    const hit = wallPoint();
    if (!hit) return;
    cand = {
      surface: hit.surface, rot: 0,
      a: clamp(Math.round(hit.along - type.w / 2), 0, S - type.w),
      b: clamp(Math.round(hit.point.y - type.h / 2), layout.minRow, H - type.h),
    };
  } else {
    const p = floorPoint();
    if (!p) return;
    const fp = footprint(type, item.rot);
    cand = {
      surface: 'floor', rot: item.rot,
      a: clamp(Math.round(p.x + drag.offset.x - fp.w / 2), 0, S - fp.w),
      b: clamp(Math.round(p.z + drag.offset.z - fp.d / 2), 0, S - fp.d),
    };
  }
  const verdict = layout.check(type, cand, item.uid);
  drag.cand = cand;
  drag.ok = verdict.ok;
  drag.reason = verdict.reason;
  setTarget(item, cand, type.surface === 'wall' ? 0.12 : 0.2);
  showMarker(type, cand, verdict.ok ? 'ok' : 'bad');
}

function endDrag(event, cancelled = false) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  const { item, moved, ok, cand, reason } = drag;
  drag = null;
  canvas.style.cursor = '';
  if (moved && ok && !cancelled) {
    commit(item, cand);
  } else {
    setTarget(item, item);
    if (moved && !cancelled) toast(reason || 'Сюда нельзя');
  }
  if (selected) showMarker(selected.type, selected, 'select');
}

canvas.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  aim(event);
  const item = pickItem();
  select(item);
  if (!item) return;
  beginDrag(item, event);
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener('pointermove', (event) => {
  aim(event);
  if (drag && event.pointerId === drag.pointerId) moveDrag(event);
  else if (event.pointerType === 'mouse') canvas.style.cursor = pickItem() ? 'grab' : '';
});

canvas.addEventListener('pointerup', (event) => endDrag(event));
canvas.addEventListener('pointercancel', (event) => endDrag(event, true));

$('#rotate').addEventListener('click', rotateSelected);
$('#remove').addEventListener('click', removeSelected);
$('#deselect').addEventListener('click', () => select(null));

window.addEventListener('keydown', (event) => {
  if ($('#result').open) return;
  const key = event.key.toLowerCase();
  if (key === 'r' || key === 'к') rotateSelected();
  else if (key === 'delete' || key === 'backspace') removeSelected();
  else if (key === 'escape') select(null);
});

// ---------------------------------------------------------------- состояние в ссылке
// Ник и коллекция остаются в адресе как пришли от бота, код комнаты
// обновляется при каждом изменении: обновил страницу - комната на месте.

function placements() {
  return layout.items
    .map((item) => ({ code: item.type.code, surface: item.surface, a: item.a, b: item.b, rot: item.rot }))
    .concat(FINISHES.filter((surface) => finish[surface])
      .map((surface) => ({ code: finish[surface].code, surface: 'floor', a: 0, b: 0, rot: 0 })))
    .concat(foreign);
}

const currentCode = () => encodeRoom(placements());

// Что записать после # - та же ссылка одним кодом, что присылает бот: в
// коллекции - то, что сейчас не стоит в комнате. В режиме каталога - только
// комната (#r=код)
function stateHash() {
  if (catalogMode) return `r=${currentCode()}`;
  const room = placements();
  const spare = new Map(allOwned);
  for (const p of room) spare.set(p.code, (spare.get(p.code) || 0) - 1);
  return encodeLink(LINK_ROOM, playerName, { inventory: spare, room });
}

function saveState() {
  history.replaceState(null, '', `#${stateHash()}`);
}

function loadState() {
  let placementsList = linked ? linked.room : [];
  const code = params.get('r');
  if (code) {
    try {
      placementsList = decodeRoom(code);
    } catch (error) {
      toast(`Комната из ссылки не открылась: ${error.message}`, 4000);
      return;
    }
  }
  if (!placementsList.length) return;
  let skipped = 0;
  placementsList.forEach((p, index) => {
    const type = typeByCode.get(p.code);
    if (!type) {
      // Сайт ещё не знает этот предмет - оставим его в коде как есть
      if (unknownOwned || catalogMode) foreign.push(p);
      else skipped++;
      return;
    }
    if (isFinish(type)) {
      if (finish[type.surface] || available(type) <= 0) skipped++;
      else finish[type.surface] = type;
      return;
    }
    const surfaceFits = (type.surface === 'wall') === (p.surface !== 'floor');
    if (!surfaceFits || available(type) <= 0 || !layout.check(type, p).ok) {
      skipped++;
      return;
    }
    spawn(type, p, index * 0.06);
  });
  if (finishCount()) rebuildRoom();
  if (skipped) {
    // В ссылке - то, что встало на самом деле
    saveState();
    toast(`Не удалось поставить: ${skipped} ${plural(skipped, ITEM_FORMS)}`, 3000);
  }
}

// ---------------------------------------------------------------- коллекция

const shopList = $('#shop-list');
const tabsEl = $('#shop-tabs');

// Разделы коллекции - вкладки над карточками
const SECTIONS = [
  { id: 'floor', title: 'Мебель', test: (type) => type.surface === 'floor' || type.surface === 'cover' },
  { id: 'wall', title: 'На стены', test: (type) => type.surface === 'wall' },
  { id: 'wallpaper', title: 'Обои', test: (type) => type.surface === 'wallpaper' },
  { id: 'flooring', title: 'Пол', test: (type) => type.surface === 'flooring' },
];
// Обычные стены и пол - карточка «как было» в начале обоев и пола
const PLAIN = {
  wallpaper: { id: '__plain_wallpaper', surface: 'wallpaper', name: 'Обычные стены', theme: {} },
  flooring: { id: '__plain_flooring', surface: 'flooring', name: 'Обычный пол', theme: {} },
};
const CHOSEN = { wallpaper: 'выбраны', flooring: 'выбран' };
let section = 'floor';

function showSection(id) {
  section = id;
  for (const tab of tabsEl.querySelectorAll('button')) tab.classList.toggle('on', tab.dataset.section === id);
  for (const group of shopList.querySelectorAll('.group')) group.hidden = group.dataset.section !== id;
  shopList.scrollTop = 0;
}

function cardFor(type, thumb) {
  const rarity = RARITIES[type.rarity];
  const card = document.createElement('button');
  card.className = 'card';
  if (rarity) card.style.setProperty('--rc', rarity.color);
  card.innerHTML = '<span class="count"></span><img alt=""><span class="name"></span>'
    + '<span class="meta"><span class="rarity"></span><span class="size"></span></span>';
  card.querySelector('img').src = thumb;
  card.querySelector('.name').textContent = type.name;
  // Вещи лавок NPC подписаны, чьи они
  const setName = type.set && SETS[type.set];
  card.querySelector('.rarity').textContent = setName || (rarity ? rarity.name : '');
  if (setName) card.classList.add('npc');
  if (!isFinish(type)) {
    card.querySelector('.size').textContent = type.surface === 'wall' ? `${type.w}×${type.h}` : `${type.w}×${type.d}`;
  }
  return card;
}

function renderCollection(thumbs) {
  shopList.replaceChildren();
  tabsEl.replaceChildren();
  if (!types.length) {
    tabsEl.hidden = true;
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M10 28h44v24a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4z" fill="#9c6b47" stroke="#5c3b24" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M10 28c0-9 6-16 22-16s22 7 22 16z" fill="#b98052" stroke="#5c3b24" stroke-width="2.5" stroke-linejoin="round"/>
        <path d="M10 28h44M18 13.5V56M46 13.5V56" stroke="#e8b64a" stroke-width="3"/>
        <rect x="27" y="24" width="10" height="12" rx="2" fill="#f2c94c" stroke="#8a6212" stroke-width="2"/>
        <circle cx="32" cy="29.5" r="1.8" fill="#5c3b24"/>
      </svg>
      <b>Коллекция пока пуста</b>
      <span>Мебель, обои и пол выпадают из сундуков в мини-игре на стриме. Найди ключ - и открой сундук!</span>`;
    shopList.append(empty);
    return;
  }
  const shown = [];
  for (const { id, title, test } of SECTIONS) {
    const items = types.filter(test);
    if (!items.length) continue;
    shown.push(id);
    const tab = document.createElement('button');
    tab.dataset.section = id;
    tab.innerHTML = `${title}<b>${items.length}</b>`;
    tab.addEventListener('click', () => showSection(id));
    tabsEl.append(tab);

    const group = document.createElement('div');
    group.className = 'group';
    group.dataset.section = id;
    const cards = document.createElement('div');
    cards.className = 'cards';
    if (PLAIN[id]) {
      // Обычные стены или пол - всегда есть, ничего не стоят
      const plain = cardFor(PLAIN[id], thumbs[PLAIN[id].id]);
      plain.classList.add('plain');
      plain.dataset.plain = id;
      plain.querySelector('.rarity').textContent = 'есть у всех';
      plain.addEventListener('click', () => setFinish(id, null));
      cards.append(plain);
    }
    for (const type of items) {
      const card = cardFor(type, thumbs[type.id]);
      card.dataset.code = type.code;
      card.addEventListener('click', () => place(type));
      cards.append(card);
    }
    group.append(cards);
    shopList.append(group);
  }
  // Одна вкладка - и вкладки не нужны
  tabsEl.hidden = shown.length < 2;
  showSection(shown.includes(section) ? section : shown[0]);
}

function refreshCollection() {
  for (const card of shopList.querySelectorAll('.card')) {
    const badge = card.querySelector('.count');
    if (card.dataset.plain) {
      const on = !finish[card.dataset.plain];
      card.classList.toggle('chosen', on);
      badge.textContent = on ? CHOSEN[card.dataset.plain] : '';
      continue;
    }
    const type = typeByCode.get(Number(card.dataset.code));
    if (isFinish(type)) {
      const on = finish[type.surface] === type;
      card.classList.toggle('chosen', on);
      badge.hidden = false;
      badge.textContent = on ? CHOSEN[type.surface] : '';
      continue;
    }
    const left = available(type);
    if (catalogMode) {
      badge.hidden = true;
      continue;
    }
    card.classList.toggle('used', left <= 0);
    badge.textContent = left > 0 ? `×${left}` : 'в комнате';
    badge.title = `В коллекции: ${owned.get(type.code)}, в комнате: ${placedCount(type)}`;
  }
  const placed = layout.items.length + finishCount();
  const total = [...owned.values()].reduce((sum, count) => sum + count, 0);
  $('#count-text').textContent = catalogMode ? `${placed} ${plural(placed, ITEM_FORMS)}` : `${placed} из ${total}`;
  $('#count-pill').title = catalogMode ? 'Предметов в комнате' : 'Сколько вещей из коллекции в комнате';
}

// ---------------------------------------------------------------- «Готово» и «Убрать всё»

const dialog = $('#result');

$('#done').addEventListener('click', () => {
  select(null);
  const code = currentCode();
  const command = catalogMode ? code : `!комната ${code}`;
  $('#result-command').textContent = command;
  $('#result-length').textContent = catalogMode
    ? `${code.length} символов · ${layout.items.length} ${plural(layout.items.length, ITEM_FORMS)}`
    : `${command.length} из 500 символов · ${layout.items.length} ${plural(layout.items.length, ITEM_FORMS)}`;
  $('#result-link').value = `${location.origin}${location.pathname}#${stateHash()}`;
  dialog.showModal();
});

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const label = button.textContent;
  button.textContent = 'Скопировано';
  setTimeout(() => { button.textContent = label; }, 1400);
}

$('#copy-command').addEventListener('click', (event) => copy($('#result-command').textContent, event.currentTarget));
$('#copy-link').addEventListener('click', (event) => copy($('#result-link').value, event.currentTarget));
$('#close-result').addEventListener('click', () => dialog.close());

$('#reset').addEventListener('click', () => {
  if (!layout.items.length && !finishCount()) return;
  if (!confirm(finishCount() ? 'Убрать всё обратно в коллекцию? Стены и пол станут обычными.'
    : 'Убрать всю мебель обратно в коллекцию?')) return;
  clearRoom();
  saveState();
  refreshCollection();
});

// ---------------------------------------------------------------- шаблоны (каталог)

function clearRoom() {
  select(null);
  for (const item of [...layout.items]) {
    layout.remove(item);
    item.scaleTarget = 0;
    leaving.push(item);
  }
  foreign = [];
  if (finishCount()) {
    for (const surface of FINISHES) finish[surface] = null;
    rebuildRoom();
  }
}

function loadTemplate(name) {
  const template = TEMPLATES[name];
  if (!template) return;
  clearRoom();
  // Обои и пол шаблона - из его комнаты, а если там нет - из его темы
  const theme = THEMES[template.theme] || {};
  for (const surface of FINISHES) {
    const type = typeById.get(theme[surface]);
    if (isFinish(type) && type.surface === surface) finish[surface] = type;
  }
  let delay = 0;
  for (const p of template.room || []) {
    const type = typeById.get(p.item);
    if (!type) continue;
    if (isFinish(type)) finish[type.surface] = type;
    else if (layout.check(type, p).ok) spawn(type, { surface: p.surface, a: p.a, b: p.b, rot: p.rot || 0 }, (delay += 0.04));
  }
  rebuildRoom();
  saveState();
  refreshCollection();
  hideHint();
}

function setupCatalogTools() {
  const box = $('#catalog-tools');
  if (!catalogMode || !Object.keys(TEMPLATES).length) return;
  box.hidden = false;
  const templates = $('#template-select');
  for (const [id, template] of Object.entries(TEMPLATES)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = template.name || id;
    templates.append(option);
  }
  templates.addEventListener('change', () => {
    if (!templates.value) return;
    if ((layout.items.length || finishCount()) && !confirm('Заменить эту комнату шаблоном?')) {
      templates.value = '';
      return;
    }
    loadTemplate(templates.value);
    templates.value = '';
  });
}

// ---------------------------------------------------------------- подсказки

const toastEl = $('#toast');
let toastTimer = 0;
function toast(text, ms = 2200) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function hideHint() {
  $('#hint').classList.add('gone');
}

// ---------------------------------------------------------------- кадр

function resize() {
  const width = stage.clientWidth, height = stage.clientHeight;
  renderer.setSize(width, height, false);
  fitCamera(camera, room.bounds, width, height);
}
new ResizeObserver(resize).observe(stage);
resize();

function turnTowards(current, target, k) {
  const diff = ((target - current + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return current + diff * k;
}

const toolbarPoint = new THREE.Vector3();
const toolbarBox = new THREE.Box3();
function placeToolbar() {
  if (!selected || toolbar.hidden) return;
  toolbarBox.setFromObject(selected.obj);
  toolbarPoint.set((toolbarBox.min.x + toolbarBox.max.x) / 2, toolbarBox.max.y + 0.2,
    (toolbarBox.min.z + toolbarBox.max.z) / 2).project(camera);
  const width = stage.clientWidth, height = stage.clientHeight;
  const x = ((toolbarPoint.x + 1) / 2) * width - toolbar.offsetWidth / 2;
  const y = ((1 - toolbarPoint.y) / 2) * height - toolbar.offsetHeight - 10;
  toolbar.style.transform = `translate(${clamp(x, 8, width - toolbar.offsetWidth - 8)}px, ${clamp(y, 64, height - toolbar.offsetHeight - 8)}px)`;
}

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  const time = clock.elapsedTime;
  const k = 1 - Math.exp(-dt * 16);

  for (const item of layout.items) {
    item.obj.position.lerp(item.target, k);
    item.obj.rotation.y = turnTowards(item.obj.rotation.y, item.targetRot, k);
    springScale(item, dt);
    item.glows.forEach((glow, i) => {
      glow.material.opacity = glow.userData.glow.base * (0.88 + 0.12 * Math.sin(time * 2.2 + item.uid + i));
    });
  }
  for (let i = leaving.length - 1; i >= 0; i--) {
    const item = leaving[i];
    springScale(item, dt);
    if (item.scale < 0.03) {
      scene.remove(item.obj);
      leaving.splice(i, 1);
    }
  }

  const gridTarget = drag && drag.moved && drag.item.type.surface !== 'wall' ? 0.16 : selected ? 0.06 : 0;
  room.grid.material.opacity += (gridTarget - room.grid.material.opacity) * k;
  markerMaterial.opacity = drag ? 0.34 : 0.22 + 0.08 * Math.sin(time * 4);

  placeToolbar();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- запуск

function setupTexts() {
  if (catalogMode) {
    document.title = 'Каталог мебели';
    $('#title').textContent = 'Каталог мебели';
    $('#mode-badge').hidden = false;
    $('#shop-title').textContent = 'Вся мебель';
    $('#shop-sub').textContent = 'Режим каталога: без ограничений, для особых комнат игры';
    $('#hint').innerHTML = 'Нажми на мебель справа - она появится в комнате.<br>Перетаскивай её мышью или пальцем. Обои и пол - на своих вкладках.';
    $('#result-title').textContent = 'Код комнаты';
    $('#result-lead').textContent = 'Код этой расстановки. Мебель в нём не сверяется ни с чьей коллекцией:';
    $('#result-note').textContent = 'Режим каталога: открыт без коллекции игрока.';
    return;
  }
  const title = playerName ? `Комната ${playerName}` : 'Моя комната';
  document.title = title;
  $('#title').textContent = title;
  const total = [...owned.values()].reduce((sum, count) => sum + count, 0);
  $('#shop-sub').textContent = total
    ? `${total} ${plural(total, ITEM_FORMS)} из сундуков и лавок мини-игры`
    : 'Мебель, обои и пол из сундуков мини-игры';
  if (!types.length) $('#hint').classList.add('gone');
}

setupTexts();
setupCatalogTools();
renderCollection(makeThumbnails(types.concat(Object.values(PLAIN)), buildModel));
loadState();
refreshCollection();
if (layout.items.length) hideHint();
$('#loading').classList.add('gone');
if (brokenLink) toast(brokenLink, 6000);
else if (unknownOwned) {
  toast(`${unknownOwned} ${plural(unknownOwned, ITEM_FORMS)} из коллекции сайт ещё не знает - стример скоро обновит страницу`, 5000);
}
window.__roomReady = true;
