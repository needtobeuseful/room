// Отделка комнаты: обои и пол.
//
// В каталоге (catalog.json) это предметы с surface "wallpaper" (обои - сразу
// на обе стены) и "flooring" (пол). Выпадают и продаются они, как мебель,
// но места в комнате не занимают: обои в комнате одни, пол - один. В коде
// комнаты отделка записана как предмет на полу в клетке (0, 0) без поворота,
// поэтому коды комнат остались прежними.
//
// Вид отделки - поле theme предмета:
//   обои: wallLeft, wallRight - цвет левой и правой стены (правая в тени,
//         потемнее); trim - торцы стен; baseboard - плинтус; pattern - узор:
//         stripes, stars, dots, hearts, diamonds, bricks, boards, clouds,
//         leaves, grid (или null - без узора); patternColor, patternColor2 -
//         его цвета, лучше полупрозрачные: узор ложится поверх цвета стены;
//         patternGlow - узор светится (неон), от 0 до 1;
//   пол:  floor - основной цвет [оттенок, насыщенность, яркость] (HSL);
//         floor2 - второй цвет: швы плитки, клетки шахмат, прожилки мрамора;
//         floorStyle - planks (доски), tiles (плитка), checker (шахматы),
//         herringbone (паркет ёлочкой), carpet (ковролин), grass (трава),
//         hex (соты), marble (мрамор); base - подставка под комнатой.
//
// Темы (catalog.json → themes) - вид комнаты по имени. Их выбирает бот для
// лавок NPC, если в коде комнаты лавки нет своих обоев и пола. В теме могут
// быть ссылки на обои и пол (wallpaper, flooring) и любые цвета из списка выше.

import * as THREE from 'three';

export const FINISHES = ['wallpaper', 'flooring'];
export const isFinish = (type) => Boolean(type) && FINISHES.includes(type.surface);

// За что отвечают обои, а за что - пол
const WALL_KEYS = ['wallLeft', 'wallRight', 'trim', 'baseboard', 'pattern', 'patternColor', 'patternColor2', 'patternGlow'];
const FLOOR_KEYS = ['floor', 'floor2', 'floorStyle', 'base'];

// Обычная комната игрока
export const DEFAULT_THEME = {
  wallLeft: '#7d889d', wallRight: '#566377', trim: '#eef1f5', baseboard: '#39404f',
  pattern: null, patternColor: 'rgba(255, 255, 255, 0.2)', patternColor2: null, patternGlow: 0,
  floor: [214, 20, 34], floor2: null, floorStyle: 'planks', base: '#262a35',
};

// Обои или пол поверх темы: всё, за что они отвечают, - их, а чего у них
// нет - как у обычной комнаты (узор прежних обоев не просвечивает)
export function applyFinish(theme, type) {
  if (!isFinish(type)) return theme;
  const own = type.theme || {};
  const result = { ...theme };
  for (const key of type.surface === 'wallpaper' ? WALL_KEYS : FLOOR_KEYS) {
    result[key] = key in own ? own[key] : DEFAULT_THEME[key];
  }
  return result;
}

// Тема комнаты: обычная, поверх - тема по имени (у лавок), поверх - обои
// и пол самой комнаты. finishes - типы предметов из каталога
export function themeOf(catalog, name, finishes = []) {
  const themes = (catalog && catalog.themes) || {};
  let theme = { ...DEFAULT_THEME, ...withoutName(themes.default) };
  const named = name && themes[name];
  if (named) {
    const byId = new Map(((catalog && catalog.items) || []).map((type) => [type.id, type]));
    for (const surface of FINISHES) theme = applyFinish(theme, byId.get(named[surface]));
    const { wallpaper, flooring, ...colors } = withoutName(named);
    theme = { ...theme, ...colors };
  }
  for (const type of finishes) theme = applyFinish(theme, type);
  return theme;
}

function withoutName(theme) {
  const { name, ...rest } = theme || {};
  return rest;
}

// Отделка из списка типов предметов комнаты - по одной каждого вида
export function finishesOf(types) {
  const found = new Map();
  for (const type of types) if (isFinish(type) && !found.has(type.surface)) found.set(type.surface, type);
  return [...found.values()];
}

// ---------------------------------------------------------------- картинки

function seeded(seed) {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

const hsl = ([h, s, l], dl = 0, alpha = 1) =>
  `hsla(${h}, ${s}%, ${Math.max(0, Math.min(100, l + dl))}%, ${alpha})`;

function canvasOf(size) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  return canvas;
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

function drawStar(ctx, x, y, r, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 ? r * 0.45 : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    ctx.lineTo(x + Math.cos(a) * radius, y + Math.sin(a) * radius);
  }
  ctx.closePath();
  ctx.fill();
}

// --- пол: картинка на весь пол комнаты, cells клеток по стороне ---

const FLOOR_STYLES = {
  // Доски: два ряда на клетку, стыки вразбежку
  planks(ctx, size, cells, color) {
    const rows = cells * 2;
    const rowHeight = size / rows;
    const random = seeded(11);
    for (let row = 0; row < rows; row++) {
      let x = -Math.floor(random() * 300);
      while (x < size) {
        const length = 240 + Math.floor(random() * 220);
        ctx.fillStyle = hsl(color, random() * 8);
        ctx.fillRect(x, row * rowHeight, length, rowHeight);
        // Волокна доски
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        for (let k = 0; k < 3; k++) {
          const y = row * rowHeight + 8 + random() * (rowHeight - 16);
          ctx.beginPath();
          ctx.moveTo(x + 10, y);
          ctx.lineTo(x + length - 10, y + (random() - 0.5) * 6);
          ctx.stroke();
        }
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(x, row * rowHeight, 3, rowHeight);
        x += length;
      }
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(0, row * rowHeight, size, 3);
    }
  },

  // Плитка: по четыре на клетку, швы вторым цветом
  tiles(ctx, size, cells, color, second) {
    const n = cells * 2, c = size / n;
    const random = seeded(5);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        ctx.fillStyle = hsl(color, random() * 5 - 2.5);
        ctx.fillRect(i * c, j * c, c, c);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(i * c, j * c, c, 4);
        ctx.fillRect(i * c, j * c, 4, c);
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        ctx.fillRect(i * c, j * c + c - 6, c, 6);
        ctx.fillRect(i * c + c - 6, j * c, 6, c);
      }
    }
    ctx.fillStyle = hsl(second);
    for (let k = 0; k <= n; k++) {
      ctx.fillRect(k * c - 2.5, 0, 5, size);
      ctx.fillRect(0, k * c - 2.5, size, 5);
    }
  },

  // Шахматы: клетка пола - клетка доски
  checker(ctx, size, cells, color, second) {
    const c = size / cells;
    const random = seeded(3);
    for (let i = 0; i < cells; i++) {
      for (let j = 0; j < cells; j++) {
        ctx.fillStyle = hsl((i + j) % 2 ? second : color, random() * 4 - 2);
        ctx.fillRect(i * c, j * c, c, c);
        // Блик на плитке
        const gradient = ctx.createLinearGradient(i * c, j * c, i * c + c, j * c + c);
        gradient.addColorStop(0, 'rgba(255,255,255,0.10)');
        gradient.addColorStop(0.5, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(i * c, j * c, c, c);
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    for (let k = 0; k <= cells; k++) {
      ctx.fillRect(k * c - 1.5, 0, 3, size);
      ctx.fillRect(0, k * c - 1.5, size, 3);
    }
  },

  // Паркет ёлочкой: плашки 4:1, лесенкой по диагонали
  herringbone(ctx, size, cells, color) {
    const w = size / (cells * 4), n = 4, L = n * w;
    const random = seeded(17);
    const plank = (x, y, pw, ph, along) => {
      if (x > size || y > size || x + pw < 0 || y + ph < 0) return;
      ctx.fillStyle = hsl(color, random() * 10 - 5);
      ctx.fillRect(x, y, pw, ph);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (along) {
        ctx.moveTo(x + 6, y + ph * (0.3 + random() * 0.4));
        ctx.lineTo(x + pw - 6, y + ph * (0.3 + random() * 0.4));
      } else {
        ctx.moveTo(x + pw * (0.3 + random() * 0.4), y + 6);
        ctx.lineTo(x + pw * (0.3 + random() * 0.4), y + ph - 6);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,0.32)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, pw - 2, ph - 2);
    };
    const K = Math.ceil(size / w) + 2 * n;
    for (let s = -K; s <= K; s++) {
      for (let k = -K; k <= 2 * K; k++) {
        const x = (k - n * s) * w, y = (k + n * s) * w;
        if (x > size + L || y > size + L || x < -2 * L || y < -2 * L) continue;
        plank(x, y, L, w, true);
        plank(x, y + w, w, L, false);
      }
    }
  },

  // Ковролин: мягкий ворс
  carpet(ctx, size, cells, color) {
    ctx.fillStyle = hsl(color);
    ctx.fillRect(0, 0, size, size);
    const random = seeded(23);
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = hsl(color, random() * 10 - 5, 0.18);
      ctx.beginPath();
      ctx.arc(random() * size, random() * size, 8 + random() * 26, 0, Math.PI * 2);
      ctx.fill();
    }
    const image = ctx.getImageData(0, 0, size, size);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (random() - 0.5) * 18;
      data[i] += noise; data[i + 1] += noise; data[i + 2] += noise;
    }
    ctx.putImageData(image, 0, 0);
  },

  // Трава: травинки и редкие цветочки
  grass(ctx, size, cells, color) {
    ctx.fillStyle = hsl(color, -6);
    ctx.fillRect(0, 0, size, size);
    const random = seeded(29);
    ctx.lineCap = 'round';
    for (let i = 0; i < 26000; i++) {
      const x = random() * size, y = random() * size;
      const length = 7 + random() * 12, angle = -Math.PI / 2 + (random() - 0.5) * 0.9;
      ctx.strokeStyle = hsl(color, random() * 22 - 8);
      ctx.lineWidth = 1.5 + random() * 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
      ctx.stroke();
    }
    for (let i = 0; i < 70; i++) {
      const x = random() * size, y = random() * size;
      ctx.fillStyle = random() < 0.5 ? '#fff6e8' : '#ffd84a';
      for (let p = 0; p < 5; p++) {
        const a = (p / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(x + Math.cos(a) * 4, y + Math.sin(a) * 4, 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#f2a23a';
      ctx.beginPath();
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  },

  // Соты: шестиугольная плитка
  hex(ctx, size, cells, color, second) {
    ctx.fillStyle = hsl(second);
    ctx.fillRect(0, 0, size, size);
    const r = size / cells / 2.2;
    const dx = Math.sqrt(3) * r, dy = 1.5 * r;
    const random = seeded(31);
    for (let row = -1; row * dy < size + r; row++) {
      for (let col = -1; col * dx < size + dx; col++) {
        const x = col * dx + (row % 2 ? dx / 2 : 0), y = row * dy;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3;
          ctx.lineTo(x + Math.cos(a) * (r - 3), y + Math.sin(a) * (r - 3));
        }
        ctx.closePath();
        ctx.fillStyle = hsl(color, random() * 8 - 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  },

  // Мрамор: большие плиты с прожилками
  marble(ctx, size, cells, color, second) {
    const n = cells / 2, c = size / n;
    const random = seeded(37);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = i * c, y = j * c;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, c, c);
        ctx.clip();
        ctx.fillStyle = hsl(color, random() * 4 - 2);
        ctx.fillRect(x, y, c, c);
        for (let v = 0; v < 4; v++) {
          ctx.strokeStyle = hsl(second, 0, 0.3 + random() * 0.4);
          ctx.lineWidth = 1 + random() * 3;
          ctx.beginPath();
          const sx = x + random() * c, sy = y - 10;
          ctx.moveTo(sx, sy);
          ctx.bezierCurveTo(x + random() * c, y + c * 0.35, x + random() * c, y + c * 0.65, x + random() * c, y + c + 10);
          ctx.stroke();
        }
        const gradient = ctx.createLinearGradient(x, y, x + c, y + c);
        gradient.addColorStop(0, 'rgba(255,255,255,0.16)');
        gradient.addColorStop(0.6, 'rgba(255,255,255,0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(x, y, c, c);
        ctx.restore();
      }
    }
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    for (let k = 0; k <= n; k++) {
      ctx.fillRect(k * c - 1.5, 0, 3, size);
      ctx.fillRect(0, k * c - 1.5, size, 3);
    }
  },
};

// Насколько пол блестит
const FLOOR_ROUGHNESS = { marble: 0.38, tiles: 0.55, checker: 0.5, hex: 0.6, carpet: 1, grass: 1 };
export const floorRoughness = (theme) => FLOOR_ROUGHNESS[theme.floorStyle] ?? 0.85;

const textures = new Map();
function cached(key, make) {
  if (!textures.has(key)) textures.set(key, make());
  return textures.get(key);
}

// Пол комнаты: cells клеток по стороне
export function floorTexture(theme, cells = 8) {
  const color = theme.floor || DEFAULT_THEME.floor;
  const second = theme.floor2 || [color[0], color[1], Math.max(0, color[2] - 18)];
  const style = FLOOR_STYLES[theme.floorStyle] ? theme.floorStyle : 'planks';
  return cached(`floor|${style}|${color}|${second}|${cells}`, () => {
    const size = 1024;
    const canvas = canvasOf(size);
    FLOOR_STYLES[style](canvas.getContext('2d'), size, cells, color, second);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  });
}

// --- обои: плитка узора 256×256, повторяется по стене ---

const WALL_PATTERNS = {
  stripes(ctx, size, c1) {
    ctx.fillStyle = c1;
    for (let x = 0; x < size; x += 64) ctx.fillRect(x, 0, 26, size);
  },

  stars(ctx, size, c1) {
    drawStar(ctx, 64, 64, 14, c1);
    drawStar(ctx, 192, 192, 14, c1);
    ctx.fillStyle = c1;
    ctx.beginPath(); ctx.arc(192, 64, 4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(64, 192, 4, 0, Math.PI * 2); ctx.fill();
  },

  dots(ctx, size, c1, c2) {
    const dot = (x, y, r, color) => {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    };
    dot(64, 64, 26, c1);
    dot(192, 192, 26, c1);
    dot(192, 64, 11, c2);
    dot(64, 192, 11, c2);
  },

  hearts(ctx, size, c1, c2) {
    drawHeart(ctx, 64, 66, 52, c1);
    drawHeart(ctx, 192, 194, 52, c1);
    drawHeart(ctx, 192, 62, 20, c2);
    drawHeart(ctx, 64, 190, 20, c2);
  },

  // Ромбы: косая решётка, в узлах - маленькие ромбики
  diamonds(ctx, size, c1, c2) {
    ctx.strokeStyle = c1;
    ctx.lineWidth = 4;
    for (let k = -2; k <= 4; k++) {
      ctx.beginPath(); ctx.moveTo(0, k * 128); ctx.lineTo(size, k * 128 + size); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, k * 128); ctx.lineTo(size, k * 128 - size); ctx.stroke();
    }
    ctx.fillStyle = c2;
    for (const [x, y] of [[64, 64], [192, 64], [64, 192], [192, 192]]) {
      ctx.beginPath();
      ctx.moveTo(x, y - 12); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 12); ctx.lineTo(x - 9, y);
      ctx.closePath();
      ctx.fill();
    }
  },

  // Кирпичи: ряды вразбежку, кирпичи чуть разного цвета, швы светлые
  bricks(ctx, size, c1, c2) {
    const h = 64, w = 128;
    const random = seeded(41);
    const shade = [0, 1, 2, 3].map(() => [random(), random()]);
    ctx.fillStyle = c2;
    for (let row = 0; row < 4; row++) {
      const offset = row % 2 ? w / 2 : 0;
      for (let k = -1; k <= 2; k++) {
        const x = k * w + offset;
        ctx.globalAlpha = 0.15 + shade[row][((k % 2) + 2) % 2] * 0.85;
        ctx.fillRect(x + 3, row * h + 3, w - 6, h - 6);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = c1;
    for (let row = 0; row <= 4; row++) ctx.fillRect(0, row * h - 3, size, 6);
    for (let row = 0; row < 4; row++) {
      const offset = row % 2 ? w / 2 : 0;
      for (let x = offset; x <= size; x += w) ctx.fillRect(x - 3, row * h, 6, h);
      if (offset) ctx.fillRect(-3 + offset - w, row * h, 6, h);
    }
  },

  // Деревянные панели: вертикальные доски с волокнами
  boards(ctx, size, c1, c2) {
    const w = 64;
    ctx.strokeStyle = c2;
    ctx.lineWidth = 1.6;
    const random = seeded(43);
    for (let x = 0; x < size; x += w) {
      for (let k = 0; k < 3; k++) {
        const base = x + 12 + random() * (w - 24), amp = 2 + random() * 4, phase = random() * Math.PI * 2;
        ctx.beginPath();
        for (let y = 0; y <= size; y += 8) ctx.lineTo(base + Math.sin((y / size) * Math.PI * 2 * 2 + phase) * amp, y);
        ctx.stroke();
      }
    }
    ctx.fillStyle = c1;
    for (let x = 0; x <= size; x += w) ctx.fillRect(x - 2.5, 0, 5, size);
  },

  clouds(ctx, size, c1) {
    const cloud = (x, y, s) => {
      ctx.fillStyle = c1;
      ctx.beginPath();
      ctx.arc(x - s * 0.5, y + s * 0.05, s * 0.34, 0, Math.PI * 2);
      ctx.arc(x - s * 0.1, y - s * 0.18, s * 0.42, 0, Math.PI * 2);
      ctx.arc(x + s * 0.38, y - s * 0.02, s * 0.36, 0, Math.PI * 2);
      ctx.fill();
      // Плоское донышко облака
      const r = s * 0.18;
      ctx.beginPath();
      ctx.arc(x - s * 0.84 + r, y + r, r, Math.PI / 2, Math.PI * 1.5);
      ctx.arc(x + s * 0.76 - r, y + r, r, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fill();
    };
    cloud(82, 76, 80);
    cloud(188, 192, 62);
  },

  leaves(ctx, size, c1, c2) {
    const leaf = (x, y, angle, length, color) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(length * 0.5, -length * 0.36, length, 0);
      ctx.quadraticCurveTo(length * 0.5, length * 0.36, 0, 0);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(length * 0.08, 0); ctx.lineTo(length * 0.9, 0); ctx.stroke();
      ctx.restore();
    };
    const random = seeded(47);
    const spots = [[40, 52], [150, 30], [206, 118], [92, 140], [30, 206], [170, 206]];
    spots.forEach(([x, y], i) => leaf(x, y, random() * Math.PI * 2, 50 + random() * 14, i % 2 ? c2 : c1));
  },

  // Неоновая сетка: светящиеся линии двух цветов
  grid(ctx, size, c1, c2) {
    ctx.lineWidth = 4;
    ctx.shadowBlur = 12;
    for (const [color, vertical] of [[c2, false], [c1, true]]) {
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      for (let k = 0; k <= size; k += 64) {
        ctx.beginPath();
        if (vertical) { ctx.moveTo(k, 0); ctx.lineTo(k, size); } else { ctx.moveTo(0, k); ctx.lineTo(size, k); }
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  },
};

// Узор обоев. background - залить цветом (для образца в лавке), без него -
// прозрачная картинка поверх стены. repeat - сколько раз узор помещается
export function wallTexture(theme, { background = null, repeat = [1, 1] } = {}) {
  if (!background && !WALL_PATTERNS[theme.pattern]) return null;
  const c1 = theme.patternColor || DEFAULT_THEME.patternColor;
  const c2 = theme.patternColor2 || c1;
  const key = `wall|${theme.pattern}|${c1}|${c2}|${background}|${repeat}`;
  return cached(key, () => {
    const size = 256;
    const canvas = canvasOf(size);
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, size, size);
    }
    if (WALL_PATTERNS[theme.pattern]) WALL_PATTERNS[theme.pattern](ctx, size, c1, c2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 4;
    texture.repeat.set(repeat[0], repeat[1]);
    return texture;
  });
}

// Слой узора чуть впереди стены: прозрачный, а у неоновых обоев - светится
export function patternMaterial(theme, repeat) {
  const texture = wallTexture(theme, { repeat });
  if (!texture) return null;
  const material = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.9, depthWrite: false });
  if (theme.patternGlow) {
    material.emissiveMap = texture;
    material.emissive = new THREE.Color(0xffffff);
    material.emissiveIntensity = theme.patternGlow;
  }
  return material;
}
