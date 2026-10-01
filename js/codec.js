// Коды для ссылок и чата Twitch: коллекция мебели, комната, гардероб, образ.
//
// Предмет в кодах - это его номер code из catalog.json. Номер никогда не
// меняется и не переиспользуется, поэтому новые предметы в каталоге старым
// кодам не мешают: коды не зависят ни от размера каталога, ни друг от друга.
//
// Код - это поток битов, записанный буквами base64url (A-Z a-z 0-9 - _):
// каждая буква - 6 бит, в чате Twitch ничего не ломается. Числа пишутся
// кодом Элиаса-Гаммы со сдвигом (Exp-Golomb): маленькие числа - короткие,
// 0 занимает один бит. Номера предметов идут по возрастанию, поэтому пишется
// не сам номер, а шаг от предыдущего - обычно это 0-2, то есть 1-3 бита.
//
// Коллекция: [3 бита вид = 1] [сколько разных предметов]
//   и на каждый: [шаг номера от предыдущего - 1] [сколько штук - 1].
// Комната:   [3 бита вид = 2] [3 бита: бит на координату - 1] [сколько предметов]
//   и на каждый: [шаг номера] [0 + 2 бита поворота - пол | 1 + бит стены]
//                [клетка a] [клетка b].
// Гардероб (вид 3) и образ (вид 4) - просто наборы номеров:
//   [3 бита вид] [сколько] и на каждый [шаг номера от предыдущего - 1].
// В конце - две буквы контрольной суммы (12 бит CRC-16): испорченный или
// скопированный не целиком код бот сразу отличит.
//
// Этот файл один и тот же в room_pages/js и avatar_pages/js (сайты
// выкладываются отдельно), а на питоне кодек повторён в src/minimap/codes.py.
// Меняйте все три вместе.
// Коллекция из 13 разных предметов - 6-8 букв, комната из 20 предметов - около 45.

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const KIND_INVENTORY = 1;
const KIND_ROOM = 2;
const KIND_WARDROBE = 3;
const KIND_LOOK = 4;
const KIND_ERRORS = {
  [KIND_INVENTORY]: 'это не код коллекции',
  [KIND_ROOM]: 'это не код комнаты',
  [KIND_WARDROBE]: 'это не код гардероба',
  [KIND_LOOK]: 'это не код образа',
};
export const MAX_ITEMS = 60;
const MAX_ZEROS = 24;   // больше нулей подряд в числе не бывает - значит, код испорчен
const SURFACES = ['floor', 'left', 'right'];

export class CodeError extends Error {}

export function crc16(values) {
  let crc = 0xffff;
  for (const value of values) {
    crc ^= value << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

class BitWriter {
  constructor() {
    this.bits = [];
  }

  write(value, count) {
    for (let i = count - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) % 2);
  }

  // Exp-Golomb: 0 -> 1, 1 -> 010, 2 -> 011, 3 -> 00100 ...
  number(value) {
    const m = value + 1;
    const length = Math.floor(Math.log2(m)) + 1;
    this.write(0, length - 1);
    this.write(m, length);
  }

  text() {
    const bits = [...this.bits];
    while (bits.length % 6) bits.push(0);
    const values = [];
    for (let i = 0; i < bits.length; i += 6) {
      values.push(bits.slice(i, i + 6).reduce((acc, bit) => acc * 2 + bit, 0));
    }
    const check = crc16(values) >> 4;
    values.push(check >> 6, check & 63);
    return values.map((value) => ALPHABET[value]).join('');
  }
}

class BitReader {
  constructor(text, kind) {
    const clean = String(text ?? '').trim();
    if (clean.length < 3) throw new CodeError('код слишком короткий');
    const values = [];
    for (const char of clean) {
      const value = ALPHABET.indexOf(char);
      if (value < 0) throw new CodeError('в коде лишние символы');
      values.push(value);
    }
    const body = values.slice(0, -2);
    const check = (values[values.length - 2] << 6) | values[values.length - 1];
    if ((crc16(body) >> 4) !== check) throw new CodeError('код скопирован не целиком или с ошибкой');
    this.bits = [];
    for (const value of body) {
      for (let i = 5; i >= 0; i--) this.bits.push((value >> i) & 1);
    }
    this.pos = 0;
    if (this.read(3) !== kind) throw new CodeError(KIND_ERRORS[kind]);
  }

  read(count) {
    if (this.pos + count > this.bits.length) throw new CodeError('код оборван');
    let value = 0;
    for (let i = 0; i < count; i++) value = value * 2 + this.bits[this.pos++];
    return value;
  }

  number() {
    let zeros = 0;
    while (this.read(1) === 0) {
      if (++zeros > MAX_ZEROS) throw new CodeError('код повреждён');
    }
    return 2 ** zeros + this.read(zeros) - 1;
  }

  // В конце могут остаться только нули, добивающие последнюю букву
  finish() {
    const rest = this.bits.slice(this.pos);
    if (rest.length >= 6 || rest.some((bit) => bit)) throw new CodeError('в коде лишние данные');
  }
}

// ------------------------------------------------------------ коллекция

// items: Map или объект {номер предмета: сколько штук}
export function encodeInventory(items) {
  const entries = [...(items instanceof Map ? items : Object.entries(items))]
    .map(([code, count]) => [Number(code), Number(count)])
    .filter(([code, count]) => code > 0 && count > 0)
    .sort((x, y) => x[0] - y[0]);
  const writer = new BitWriter();
  writer.write(KIND_INVENTORY, 3);
  writer.number(entries.length);
  let previous = 0;
  for (const [code, count] of entries) {
    writer.number(code - previous - 1);
    writer.number(count - 1);
    previous = code;
  }
  return writer.text();
}

// Возвращает Map {номер предмета: сколько штук}
export function decodeInventory(text) {
  const reader = new BitReader(text, KIND_INVENTORY);
  const count = reader.number();
  if (count > 10000) throw new CodeError('код повреждён');
  const items = new Map();
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const code = previous + reader.number() + 1;
    items.set(code, reader.number() + 1);
    previous = code;
  }
  reader.finish();
  return items;
}

// ------------------------------------------------------------ комната

function sortKey(p) {
  return [p.code, SURFACES.indexOf(p.surface), p.a, p.b, p.rot];
}

function compare(x, y) {
  const a = sortKey(x), b = sortKey(y);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// placements: [{ code, surface: 'floor' | 'left' | 'right', a, b, rot }]
export function encodeRoom(placements) {
  const list = [...placements].sort(compare);
  if (list.some((p) => !(p.code >= 1))) throw new CodeError('у предмета нет номера');
  const biggest = Math.max(1, ...list.flatMap((p) => [p.a, p.b]));
  const coordBits = Math.floor(Math.log2(biggest)) + 1;
  if (coordBits > 8) throw new CodeError('комната слишком большая');
  const writer = new BitWriter();
  writer.write(KIND_ROOM, 3);
  writer.write(coordBits - 1, 3);
  writer.number(list.length);
  let previous = 1;
  for (const p of list) {
    writer.number(p.code - previous);
    if (p.surface === 'floor') {
      writer.write(0, 1);
      writer.write(p.rot & 3, 2);
    } else {
      writer.write(1, 1);
      writer.write(p.surface === 'right' ? 1 : 0, 1);
    }
    writer.write(p.a, coordBits);
    writer.write(p.b, coordBits);
    previous = p.code;
  }
  return writer.text();
}

export function decodeRoom(text) {
  const reader = new BitReader(text, KIND_ROOM);
  const coordBits = reader.read(3) + 1;
  const count = reader.number();
  if (count > MAX_ITEMS) throw new CodeError(`в комнате больше ${MAX_ITEMS} предметов`);
  const placements = [];
  let previous = 1;
  for (let i = 0; i < count; i++) {
    const code = previous + reader.number();
    let surface = 'floor', rot = 0;
    if (reader.read(1) === 0) rot = reader.read(2);
    else surface = reader.read(1) ? 'right' : 'left';
    const a = reader.read(coordBits);
    const b = reader.read(coordBits);
    placements.push({ code, surface, a, b, rot });
    previous = code;
  }
  reader.finish();
  return placements;
}

// ------------------------------------------------------------ гардероб и образ

function encodeSet(kind, codes) {
  const list = [...new Set([...codes].map(Number))].sort((x, y) => x - y);
  if (list.some((code) => !(code >= 1))) throw new CodeError('у предмета нет номера');
  const writer = new BitWriter();
  writer.write(kind, 3);
  writer.number(list.length);
  let previous = 0;
  for (const code of list) {
    writer.number(code - previous - 1);
    previous = code;
  }
  return writer.text();
}

function decodeSet(kind, text) {
  const reader = new BitReader(text, kind);
  const count = reader.number();
  if (count > 10000) throw new CodeError('код повреждён');
  const codes = [];
  let previous = 0;
  for (let i = 0; i < count; i++) {
    previous = previous + reader.number() + 1;
    codes.push(previous);
  }
  reader.finish();
  return codes;
}

// Гардероб: номера одежды, которая есть у зрителя (кроме той, что есть у всех)
export const encodeWardrobe = (codes) => encodeSet(KIND_WARDROBE, codes);
export const decodeWardrobe = (text) => decodeSet(KIND_WARDROBE, text);
// Образ: номера того, что надето, - по одному на слот
export const encodeLook = (codes) => encodeSet(KIND_LOOK, codes);
export const decodeLook = (text) => decodeSet(KIND_LOOK, text);
