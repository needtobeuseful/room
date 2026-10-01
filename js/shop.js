// Лавка NPC в комнате: продавец за прилавком, товары на манекенах и
// подиумах, а персонаж игрока прыжками идёт от входа к прилавку и обратно.
//
// Этим пользуется view.js, когда виджет мини-игры просит показать лавку
// (prepare с полем shop). Сама комната - обычный код комнаты: прилавок,
// манекены и подиумы стоят там, где их поставил стример в редакторе.
//   Продавец встаёт за прилавком (мебель counter_*), посередине, лицом к залу.
//   Покупатель подходит к прилавку спереди.
//   Одежда в лавке - на манекенах (mannequin), мебель - на подиумах
//   (pedestal), по порядку слева направо. Если мест меньше, чем товаров,
//   товары в комнате не показываются - виджет покажет их списком.
//
// Клетки пола: a - по оси x, b - по оси z (как в layout.js).

import * as THREE from 'three';
import { buildModel } from './models.js';
import { poseFor, VIEW_DIRECTION } from './room.js';

// Прыжок персонажа в лавке: на клетку за прыжок. Те же числа - в виджете
// (obs_widgets/minimap/app.js, SHOP_HOP_MS): он стучит фишкой в такт
export const SHOP_HOP_MS = 330;
export const SHOP_HOP_GAP_MS = 45;
// Больше прыжков не делаем: путь длиннее - прыжки короче по времени
const MAX_WALK_MS = 2000;
const HOP_HEIGHT = 0.34;

const MANNEQUIN = 'mannequin';
const PEDESTAL = 'pedestal';
const PEDESTAL_TOP = 0.37;

// Круглая подставка под манекен - как у манекена в каталоге (models.js)
function stand(at) {
  const group = new THREE.Group();
  group.position.set(at.x, 0, at.z);
  const wood = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.06, 24), new THREE.MeshStandardMaterial({ color: 0xc5935f, roughness: 0.78 }));
  wood.position.y = 0.03;
  const gold = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 24), new THREE.MeshStandardMaterial({ color: 0xe9b949, metalness: 0.6, roughness: 0.3 }));
  gold.position.y = 0.075;
  for (const m of [wood, gold]) {
    m.castShadow = m.receiveShadow = true;
    group.add(m);
  }
  return group;
}

const lerpAngle = (from, to, k) => from + ((((to - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k);
const cellCenter = (cell) => new THREE.Vector3(cell.a + 0.5, 0, cell.b + 0.5);

export class Shop {
  // scene - сцена комнаты, layout - расставленная мебель, items - её модели,
  // kit - фигурки (avatar_pages/js/figure.js), size - сторона комнаты в клетках
  constructor({ scene, layout, items, kit, size }) {
    this.scene = scene;
    this.layout = layout;
    this.items = items;
    this.kit = kit;
    this.size = size;
    this.objects = [];     // всё, что лавка добавила в сцену
    this.tweens = [];
    this.goods = [];       // [{model, spot, base, scale, top}] - товар на месте
    this.npc = null;
    this.player = null;
    this.playerAt = null;  // клетка, где стоит персонаж
    this.hop = null;       // текущий прыжок
    this.queue = [];       // клетки, куда ещё прыгать
    this.facing = 0;
    this.faceTarget = 0;
    this.findPlaces();
  }

  // ---------------------------------------------------------------- места

  free(a, b) {
    if (a < 0 || b < 0 || a >= this.size || b >= this.size) return false;
    const probe = { surface: 'floor', w: 1, d: 1, height: 1, name: '' };
    return this.layout.check(probe, { surface: 'floor', a, b, rot: 0 }).ok;
  }

  // Где продавец, где покупатель, где вход
  findPlaces() {
    const counter = this.items.find((item) => item.type.id.startsWith('counter'));
    let npc = null, customer = null;
    this.front = new THREE.Vector3(1, 0, 1).normalize();
    if (counter) {
      const pose = poseFor(counter.type, counter);
      const rot = (counter.rot * Math.PI) / 2;
      const front = new THREE.Vector3(Math.sin(rot), 0, Math.cos(rot));
      const depth = counter.rot % 2 ? counter.type.w : counter.type.d;
      const back = pose.pos.clone().addScaledVector(front, -(counter.type.d / 2 + 0.5));
      const ahead = pose.pos.clone().addScaledVector(front, counter.type.d / 2 + 0.5);
      npc = this.nearestFree(back, 1.6, front, -1);
      // Покупатель - перед прилавком, но не прямо перед продавцом, а сбоку:
      // так, чтобы на экране они стояли подальше друг от друга и он не
      // загораживал продавца от зрителя
      const along = new THREE.Vector3(front.z, 0, -front.x);
      const screenX = (cell) => cell.a - cell.b;
      const spots = [-1, 0, 1].map((k) => ahead.clone().addScaledVector(along, k))
        .map((p) => ({ a: Math.floor(p.x), b: Math.floor(p.z) }))
        .filter((cell) => this.free(cell.a, cell.b));
      if (npc) spots.sort((x, y) => Math.abs(screenX(y) - screenX(npc)) - Math.abs(screenX(x) - screenX(npc)));
      customer = spots[0] || this.nearestFree(ahead, 2.5, front, 1);
      this.front = front;
      this.counterDepth = depth;
    }
    if (!npc) npc = this.nearestFree(new THREE.Vector3(1.5, 0, 1.5), 99);
    if (!customer && npc) customer = this.nearestFree(cellCenter(npc).add(new THREE.Vector3(1.4, 0, 1.4)), 99);
    this.npcCell = npc;
    this.customerCell = customer;
    // Вход - свободная клетка поближе к переднему краю комнаты (к зрителю),
    // откуда до прилавка три-пять прыжков
    const reach = customer ? this.distances(customer) : new Map();
    let best = null;
    for (const [key, steps] of reach) {
      const [a, b] = key.split(',').map(Number);
      const score = -(a + b) + Math.abs(a - b) * 0.7 + Math.max(0, 3 - steps) * 3 + Math.max(0, steps - 5) * 2.5;
      if (!best || score < best.score) best = { a, b, score };
    }
    this.entrance = best ? { a: best.a, b: best.b } : customer;
    this.path = customer && this.entrance ? this.route(this.entrance, customer) : [];
  }

  // Ближайшая к точке свободная клетка. side - с какой стороны прилавка
  // (по front) её искать: -1 - за ним, 1 - перед ним
  nearestFree(point, limit, front = null, side = 0) {
    let best = null;
    for (let a = 0; a < this.size; a++) {
      for (let b = 0; b < this.size; b++) {
        if (!this.free(a, b)) continue;
        const center = cellCenter({ a, b });
        if (front && side && center.clone().sub(point).dot(front) * side < -0.6) continue;
        const d = center.distanceTo(point);
        if (d <= limit && (!best || d < best.d)) best = { a, b, d };
      }
    }
    return best ? { a: best.a, b: best.b } : null;
  }

  neighbors(cell) {
    const out = [];
    for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const a = cell.a + da, b = cell.b + db;
      if (!this.free(a, b)) continue;
      // По диагонали - только если не срезаем угол мебели
      if (da && db && (!this.free(cell.a + da, cell.b) || !this.free(cell.a, cell.b + db))) continue;
      out.push({ a, b });
    }
    return out;
  }

  distances(from) {
    const seen = new Map([[`${from.a},${from.b}`, 0]]);
    const queue = [from];
    while (queue.length) {
      const cell = queue.shift();
      const steps = seen.get(`${cell.a},${cell.b}`);
      for (const next of this.neighbors(cell)) {
        const key = `${next.a},${next.b}`;
        if (!seen.has(key)) {
          seen.set(key, steps + 1);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  // Клетки пути от from до to включительно
  route(from, to) {
    const back = new Map([[`${from.a},${from.b}`, null]]);
    const queue = [from];
    while (queue.length) {
      const cell = queue.shift();
      if (cell.a === to.a && cell.b === to.b) break;
      for (const next of this.neighbors(cell)) {
        const key = `${next.a},${next.b}`;
        if (!back.has(key)) {
          back.set(key, cell);
          queue.push(next);
        }
      }
    }
    if (!back.has(`${to.a},${to.b}`)) return [from];
    const path = [];
    for (let cell = to; cell; cell = back.get(`${cell.a},${cell.b}`)) path.unshift(cell);
    return path;
  }

  // ---------------------------------------------------------------- фигурки

  add(object) {
    this.scene.add(object);
    this.objects.push(object);
    return object;
  }

  // Продавец за прилавком, лицом к покупателю
  placeNpc(look) {
    if (!this.kit || !look || !this.npcCell) return;
    const npc = this.kit.buildFigure(this.kit.wardrobe, look);
    npc.position.copy(cellCenter(this.npcCell));
    const toward = this.customerCell ? cellCenter(this.customerCell).sub(npc.position) : this.front.clone();
    npc.rotation.y = Math.atan2(toward.x, toward.z);
    npc.userData.rest = npc.rotation.y;
    for (const arm of npc.userData.arms || []) arm.userData.rest = arm.rotation.clone();
    npc.userData.blinker = new this.kit.Blinker();
    this.npc = this.add(npc);
  }

  // Персонаж игрока - у входа, лицом к зрителю (как картинка в виджете)
  placePlayer(model) {
    this.player = model;
    this.playerAt = this.entrance;
    model.position.copy(cellCenter(this.entrance));
    this.facing = this.faceTarget = this.kit ? this.kit.FACING.down : 0;
    model.rotation.y = this.facing;
  }

  // ---------------------------------------------------------------- товары

  // Места под товары: манекены для одежды, подиумы для мебели - слева направо
  spots(kind) {
    const id = kind === 'outfit' ? MANNEQUIN : PEDESTAL;
    const right = new THREE.Vector3(1, 0, -1).normalize();
    return this.items.filter((item) => item.type.id === id)
      .sort((x, y) => poseFor(x.type, x).pos.dot(right) - poseFor(y.type, y).pos.dot(right));
  }

  // Разложить товары. goods - [{id, kind}] от бота. Возвращает false, если мест не хватило
  display(goods, catalogTypes) {
    if (!goods.length) return true;
    const spots = this.spots(goods[0].kind);
    if (spots.length < goods.length) return false;
    goods.forEach((good, index) => {
      const spot = spots[index];
      const pose = poseFor(spot.type, spot);
      let model, top;
      if (good.kind === 'outfit') {
        if (!this.kit || !this.kit.buildMannequin) return;
        // Манекен в товаре на той же круглой подставке
        model = this.kit.buildMannequin(this.kit.wardrobe, good.id);
        model.position.set(pose.pos.x, 0.09, pose.pos.z);
        model.rotation.y = this.kit.FACING.down;
        this.add(stand(pose.pos));
        spot.hidden = true;
        spot.obj.visible = false;
        top = 2.42;
      } else {
        const type = catalogTypes.get(good.id);
        if (!type) return;
        model = buildModel(type);
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const scale = Math.min(1, 1.35 / Math.max(size.x, size.z, 0.01), 1.45 / Math.max(size.y, 0.01));
        const holder = new THREE.Group();
        // Настенное ставим стоймя, всё - лицом к зрителю
        const center = box.getCenter(new THREE.Vector3());
        model.position.set(-center.x, -box.min.y, -center.z);
        holder.add(model);
        holder.scale.setScalar(scale);
        holder.position.set(pose.pos.x, PEDESTAL_TOP, pose.pos.z);
        holder.rotation.y = Math.PI / 4;
        model = holder;
        top = PEDESTAL_TOP + size.y * scale + 0.25;
      }
      model.userData.goodScale = model.scale.x;
      model.scale.multiplyScalar(0.001);
      this.add(model);
      this.goods[index] = { model, spot, kind: good.kind, base: model.userData.goodScale, scale: 0.001, target: 0,
        speed: 0, top, point: new THREE.Vector3(pose.pos.x, top, pose.pos.z), sold: false };
    });
    return true;
  }

  // Точки над товарами - там виджет вешает ценники
  tagPoints() {
    return this.goods.map((good) => (good ? good.point : null));
  }

  // Товары вырастают по очереди, проданные - пустые места
  showGoods(sold = []) {
    this.goods.forEach((good, index) => {
      if (!good) return;
      good.sold = Boolean(sold[index]);
      if (good.sold) {
        good.model.visible = false;
        if (good.spot.hidden) {
          good.spot.hidden = false;
          good.spot.obj.visible = true;
        }
        return;
      }
      this.later(250 + index * 110, () => { good.target = 1; });
    });
  }

  // Товар продан: уменьшается и исчезает, на манекене снова пусто
  sell(index) {
    const good = this.goods[index];
    if (!good || good.sold) return;
    good.sold = true;
    good.target = 0;
    this.later(380, () => {
      good.model.visible = false;
      if (good.spot.hidden) {
        good.spot.hidden = false;
        good.spot.obj.visible = true;
        good.spot.scale = 0.2;
        good.spot.scaleSpeed = 0;
      }
    });
  }

  // ---------------------------------------------------------------- движение

  later(ms, fn) {
    this.tweens.push({ at: performance.now() + ms, fn });
  }

  // Сколько длится прыжок, чтобы весь путь занял не больше MAX_WALK_MS
  hopMs(steps) {
    if (!steps) return SHOP_HOP_MS;
    return Math.min(SHOP_HOP_MS, MAX_WALK_MS / steps - SHOP_HOP_GAP_MS);
  }

  // Допрыгать к прилавку (to = 'counter') или обратно ко входу ('door').
  // instant - сразу встать там (виджет открыли, когда игрок уже в лавке)
  walk(to, instant = false) {
    const path = to === 'counter' ? this.path : [...this.path].reverse();
    this.walkTo = to;
    if (!this.player || !path.length) return;
    if (instant) {
      this.queue = [];
      this.hop = null;
      const cell = path[path.length - 1];
      this.player.position.copy(cellCenter(cell));
      this.playerAt = cell;
      this.arrive();
      this.facing = this.faceTarget;
      return;
    }
    this.queue = path.slice(1);
    this.stepMs = this.hopMs(this.queue.length);
    this.nextHopAt = performance.now();
  }

  startHop(cell) {
    const from = this.player.position.clone();
    const to = cellCenter(cell);
    const dir = to.clone().sub(from);
    this.faceTarget = Math.atan2(dir.x, dir.z);
    this.hop = { from, to, start: performance.now(), ms: this.stepMs };
    this.playerAt = cell;
  }

  // Куда смотреть, когда дошёл: у прилавка - на продавца, у входа - на зрителя
  arrive() {
    if (this.walkTo === 'counter' && this.npc) {
      const dir = this.npc.position.clone().sub(this.player.position);
      this.faceTarget = Math.atan2(dir.x, dir.z);
    } else if (this.kit) {
      this.faceTarget = this.kit.FACING.down;
    }
  }

  // Персонаж подпрыгивает на месте - получил покупку
  jump() {
    if (!this.player || this.hop) return;
    const at = this.player.position.clone();
    this.hop = { from: at, to: at, start: performance.now(), ms: 300, small: true };
  }

  // ---------------------------------------------------------------- продавец

  // Помахать рукой, обрадоваться, покачать головой, протянуть товар
  react(kind) {
    const npc = this.npc;
    if (!npc) return;
    const arms = npc.userData.arms || [];
    const start = performance.now();
    if (kind === 'wave' && arms[0]) {
      npc.userData.anim = { kind, start, ms: 1100 };
    } else if (kind === 'happy') {
      npc.userData.anim = { kind, start, ms: 650 };
    } else if (kind === 'no') {
      npc.userData.anim = { kind, start, ms: 700 };
    } else if (kind === 'give') {
      npc.userData.anim = { kind, start, ms: 900 };
    }
  }

  animateNpc(time, now) {
    const npc = this.npc;
    if (!npc) return;
    const data = npc.userData;
    const arms = data.arms || [];
    // Крылья машут, хвост покачивается, нимб парит
    for (const wing of data.wings || []) {
      wing.rotation.y = wing.userData.rest + Math.sin(time * 2.1) * 0.13 * wing.userData.side;
    }
    if (data.tail) data.tail.rotation.z = Math.sin(time * 1.5) * 0.14;
    if (data.halo) data.halo.position.y = (data.halo.userData.y ??= data.halo.position.y) + Math.sin(time * 2.4) * 0.025;
    let lift = 0, turn = 0;
    for (const arm of arms) arm.rotation.copy(arm.userData.rest);
    const anim = data.anim;
    if (anim) {
      const t = (now - anim.start) / anim.ms;
      if (t >= 1) {
        data.anim = null;
      } else if (anim.kind === 'wave') {
        const up = Math.sin(Math.min(1, t * 4) * Math.PI / 2) * (t > 0.8 ? (1 - t) / 0.2 : 1);
        arms[0].rotation.z = arms[0].userData.rest.z - up * (2.35 + Math.sin(t * Math.PI * 8) * 0.28);
      } else if (anim.kind === 'happy') {
        lift = Math.sin(t * Math.PI) * 0.16;
        for (const [i, arm] of arms.entries()) arm.rotation.z = arm.userData.rest.z + (i ? 1 : -1) * Math.sin(t * Math.PI) * 0.9;
      } else if (anim.kind === 'no') {
        turn = Math.sin(t * Math.PI * 4) * 0.22 * (1 - t);
      } else if (anim.kind === 'give') {
        const reach = Math.sin(Math.min(1, t * 1.6) * Math.PI / 2) * (t > 0.7 ? (1 - t) / 0.3 : 1);
        if (arms[0]) arms[0].rotation.x = -1.25 * reach;
        if (arms[1]) arms[1].rotation.x = -1.25 * reach;
      }
    }
    npc.rotation.y = data.rest + turn;
    npc.position.y = lift;
    this.kit.breathe(npc, time + 0.7);
    data.blinker.update(npc, time);
  }

  // ---------------------------------------------------------------- кадр

  update(dt, time) {
    const now = performance.now();
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      if (now >= this.tweens[i].at) {
        const tween = this.tweens.splice(i, 1)[0];
        tween.fn();
      }
    }
    // Товары: пружинка при появлении и исчезновении, мебель на подиумах крутится
    for (const good of this.goods) {
      if (!good) continue;
      const force = (good.target - good.scale) * 230 - good.speed * 16;
      good.speed += force * dt;
      good.scale = Math.max(0.001, good.scale + good.speed * dt);
      good.model.scale.setScalar(good.base * good.scale);
      if (good.kind === 'furniture') good.model.rotation.y += dt * 0.45;
      else good.model.rotation.y = this.kit.FACING.down + Math.sin(time * 0.7 + good.point.x * 1.7) * 0.4;
    }
    this.animateNpc(time, now);
    const player = this.player;
    if (!player) return;
    // Прыжки персонажа
    if (!this.hop && this.queue.length && now >= this.nextHopAt) this.startHop(this.queue.shift());
    if (this.hop) {
      const t = Math.min(1, (now - this.hop.start) / this.hop.ms);
      const ease = t * t * (3 - 2 * t);
      player.position.lerpVectors(this.hop.from, this.hop.to, ease);
      player.position.y = 4 * (this.hop.small ? 0.16 : HOP_HEIGHT) * t * (1 - t);
      if (t >= 1) {
        player.position.y = 0;
        this.hop = null;
        this.nextHopAt = now + SHOP_HOP_GAP_MS;
        if (!this.queue.length) this.arrive();
      }
    }
    this.facing = lerpAngle(this.facing, this.faceTarget, 1 - Math.exp(-dt * 14));
    player.rotation.y = this.facing;
  }

  dispose() {
    for (const object of this.objects) this.scene.remove(object);
    for (const good of this.goods) if (good) this.scene.remove(good.model);
    this.objects = [];
    this.goods = [];
  }
}

// Точки фигурки в мире: голова и руки - для виджета (туда летят сердечки)
export function figurePoints(model, headY) {
  const at = model.position;
  const forward = new THREE.Vector3(Math.sin(model.rotation.y), 0, Math.cos(model.rotation.y));
  return {
    head: new THREE.Vector3(at.x, headY, at.z),
    hands: new THREE.Vector3(at.x, 1.0, at.z).addScaledVector(forward, 0.35),
  };
}

export { VIEW_DIRECTION };
