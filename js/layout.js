// Правила расстановки: где предмет может стоять, а где нет.
// Здесь нет ничего от three.js - только клетки. Эти же правила потом
// повторит бот, когда будет проверять присланный из чата код.
//
// Комната - квадрат size x size клеток. Координаты пола: a - по оси x,
// b - по оси z. Две стены: left (плоскость x = 0, клетки идут вдоль z)
// и right (плоскость z = 0, клетки идут вдоль x). На стене a - клетка
// вдоль стены, b - ряд от пола.

export function footprint(type, rot = 0) {
  if (type.surface === 'wall') return { w: type.w, h: type.h };
  const odd = rot % 2 === 1;
  return { w: odd ? type.d : type.w, d: odd ? type.w : type.d };
}

// Слой: предметы одного слоя не могут пересекаться. Ковёр живёт в своём
// слое, поэтому на него можно ставить мебель.
function layerOf(type, surface) {
  if (type.surface === 'wall') return surface;
  return type.surface === 'cover' ? 'cover' : 'floor';
}

function rectOf(type, p) {
  const fp = footprint(type, p.rot);
  return {
    layer: layerOf(type, p.surface),
    x0: p.a,
    x1: p.a + fp.w,
    y0: p.b,
    y1: p.b + (type.surface === 'wall' ? fp.h : fp.d),
  };
}

const overlap = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

export class Layout {
  constructor(room) {
    this.size = room.size;
    this.height = room.wallHeight;
    this.minRow = room.wallMinRow ?? 1;
    this.items = [];
  }

  add(item) {
    this.items.push(item);
  }

  remove(item) {
    this.items = this.items.filter((other) => other !== item);
  }

  byUid(uid) {
    return this.items.find((item) => item.uid === uid) || null;
  }

  inBounds(type, p) {
    const r = rectOf(type, p);
    if (r.x0 < 0 || r.x1 > this.size) return false;
    if (type.surface === 'wall') return r.y0 >= this.minRow && r.y1 <= this.height;
    return r.y0 >= 0 && r.y1 <= this.size;
  }

  // Может ли предмет type стоять в позиции p. ignoreUid - сам предмет,
  // когда его двигают: мешать самому себе он не должен.
  check(type, p, ignoreUid = null) {
    if (!this.inBounds(type, p)) return { ok: false, reason: 'Не помещается в комнату' };
    const mine = rectOf(type, p);
    for (const other of this.items) {
      if (other.uid === ignoreUid) continue;
      const theirs = rectOf(other.type, other);
      if (theirs.layer === mine.layer
          && overlap(mine.x0, mine.x1, theirs.x0, theirs.x1)
          && overlap(mine.y0, mine.y1, theirs.y0, theirs.y1)) {
        return { ok: false, reason: `Мешает: ${other.type.name}` };
      }
      if (this.#wallClash(type, p, mine, other.type, other, theirs)) {
        return { ok: false, reason: `Мешает: ${other.type.name}` };
      }
    }
    return { ok: true, reason: '' };
  }

  // Высокая мебель у стены закрывает то, что висит на стене за ней
  #wallClash(typeA, pA, rectA, typeB, pB, rectB) {
    let wall, wallRect, floorType, floorRect;
    if (typeA.surface === 'wall' && rectB.layer === 'floor') {
      [wall, wallRect, floorType, floorRect] = [pA.surface, rectA, typeB, rectB];
    } else if (typeB.surface === 'wall' && rectA.layer === 'floor') {
      [wall, wallRect, floorType, floorRect] = [pB.surface, rectB, typeA, rectA];
    } else {
      return false;
    }
    if ((floorType.height ?? 1) <= wallRect.y0) return false;
    if (wall === 'left') {
      return floorRect.x0 === 0 && overlap(floorRect.y0, floorRect.y1, wallRect.x0, wallRect.x1);
    }
    return floorRect.y0 === 0 && overlap(floorRect.x0, floorRect.x1, wallRect.x0, wallRect.x1);
  }

  // Свободное место для только что купленного предмета - поближе к центру
  findSpot(type) {
    const candidates = [];
    if (type.surface === 'wall') {
      for (const surface of ['right', 'left']) {
        for (let b = this.minRow; b + type.h <= this.height; b++) {
          for (let a = 0; a + type.w <= this.size; a++) {
            const score = Math.abs(a + type.w / 2 - this.size / 2) + Math.abs(b + type.h / 2 - 2.8) * 1.5;
            candidates.push({ p: { surface, a, b, rot: 0 }, score });
          }
        }
      }
    } else {
      // Крупная мебель встаёт спиной к стене: у правой стены (b = 0) без
      // поворота, у левой (a = 0) - повёрнутой на 90°, лицом в комнату.
      // Ковёр, кресла и прочее с prefer: "center" - поближе к середине.
      const center = this.size / 2;
      const nearWalls = type.prefer !== 'center';
      for (const rot of [0, 1, 2, 3]) {
        const fp = footprint(type, rot);
        for (let a = 0; a + fp.w <= this.size; a++) {
          for (let b = 0; b + fp.d <= this.size; b++) {
            const cx = a + fp.w / 2, cz = b + fp.d / 2;
            let score = Math.hypot(cx - center, cz - center) + (rot ? 0.6 : 0);
            if (nearWalls) {
              const backToRight = rot === 0 && b === 0;
              const backToLeft = rot === 1 && a === 0;
              score = backToRight ? Math.abs(cx - center)
                : backToLeft ? Math.abs(cz - center) + 0.3
                : 20 + score;
            } else if (rot > 1) {
              continue;
            }
            candidates.push({ p: { surface: 'floor', a, b, rot }, score });
          }
        }
      }
    }
    candidates.sort((x, y) => x.score - y.score);
    const found = candidates.find(({ p }) => this.check(type, p).ok);
    return found ? found.p : null;
  }
}
