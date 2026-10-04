// Коды для ссылок и чата Twitch: коллекция мебели, комната, гардероб, образ
// и ссылка на сайт одним кодом.
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
// Ссылка одним кодом (вид 6): [3 бита вид = 6] [страница] [ник] и дальше
//   комната (страница 0):  [коллекция*: мебель, которой нет в комнате] [комната];
//   персонаж (страница 1): [гардероб] [образ];
//   подарки (страница 2):  [коллекция*: свободная мебель] [свободная одежда].
//   Всё - без своих 3 бит вида и контрольных сумм. Коллекция* - со штуками
//   кодом Exp-Golomb порядка k: [сколько разных] [k] и на каждый
//   [шаг номера - 1] [штук - 1 кодом порядка k].
// Ник: [0 - латиница, цифры и _: длина (Exp-Golomb порядка 3), по 6 бит на
//   букву] или [1 - текст: длина, бит «первая буква заглавная», коды
//   Хаффмана символов по частотам русских букв] - как в stats_pages/js/codec.js.
// В конце - две буквы контрольной суммы (12 бит CRC-16): испорченный или
// скопированный не целиком код бот сразу отличит.
//
// Раньше ссылка была из отдельных кодов: #n=ник&i=коллекция&r=комната (l= -
// образ, w= - одежда для подарков). Такие ссылки сайты по-прежнему понимают
// (readLink).
//
// Этот файл один и тот же в room_pages/js и avatar_pages/js (сайты
// выкладываются отдельно, копию для сайта подарков бот кладёт сам), а на
// питоне кодек повторён в src/minimap/codes.py. Меняйте все вместе.
// Коллекция из 13 разных предметов - 6-8 букв, комната из 20 предметов - около 45.

export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const KIND_INVENTORY = 1;
const KIND_ROOM = 2;
const KIND_WARDROBE = 3;
const KIND_LOOK = 4;
const KIND_LINK = 6;
const KIND_ERRORS = {
  [KIND_INVENTORY]: 'это не код коллекции',
  [KIND_ROOM]: 'это не код комнаты',
  [KIND_WARDROBE]: 'это не код гардероба',
  [KIND_LOOK]: 'это не код образа',
  [KIND_LINK]: 'это не ссылка на сайт игры',
};
// Страницы ссылки одним кодом
export const LINK_ROOM = 0;
export const LINK_AVATAR = 1;
export const LINK_GIFTS = 2;
export const MAX_ITEMS = 60;
const MAX_ZEROS = 24;   // больше нулей подряд в числе не бывает - значит, код испорчен
const SURFACES = ['floor', 'left', 'right'];

// Текст (ник не латиницей): символы и длины их кодов Хаффмана - те же, что в
// src/minimap/codes.py (TEXT_TABLE, TEXT_LENGTHS). Менять нельзя
const NAME_CHARS = ALPHABET.slice(0, 62) + '_';
const MAX_TEXT = 200;
const TABLE = ' оеаинтсрвлкмдпуяыьгзбчйхжшюцщэфъё' + '.,!?-:«»"\'()' + '0123456789' + 'abcdefghijklmnopqrstuvwxyz';
const UPPER = TABLE.length;
const RAW = TABLE.length + 1;
const LENGTHS = [3, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 6, 6, 6, 6, 6, 6, 6, 6, 7, 7, 7, 8, 8, 8, 9, 9, 9,
  12, 11, 8, 8, 8, 9, 8, 11, 11, 10, 11, 12, 12, 12, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 11,
  11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11, 11,
  11, 7, 10];
const LONGEST = Math.max(...LENGTHS);
const TABLE_INDEX = new Map([...TABLE].map((char, index) => [char, index]));

// Канонический код Хаффмана: по длине, при равной длине - по порядку в таблице
const HUFFMAN = (() => {
  const order = LENGTHS.map((length, symbol) => [length, symbol]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const codes = new Map();     // символ -> [код, длина]
  const symbols = new Map();   // `длина:код` -> символ
  let code = 0, previous = 0;
  for (const [length, symbol] of order) {
    code *= 2 ** (length - previous);
    previous = length;
    codes.set(symbol, [code, length]);
    symbols.set(`${length}:${code}`, symbol);
    code += 1;
  }
  return { codes, symbols };
})();

// Строчная буква таблицы, если char - её заглавная. Иначе null
function upperOf(char) {
  const low = char.toLowerCase();
  if (char !== low && [...low].length === 1 && TABLE_INDEX.has(low) && low.toUpperCase() === char) return low;
  return null;
}

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

  // Exp-Golomb порядка order: младшие order бит пишутся как есть
  numberK(value, order) {
    this.number(Math.floor(value / 2 ** order));
    this.write(value % 2 ** order, order);
  }

  symbol(symbol) {
    const [code, length] = HUFFMAN.codes.get(symbol);
    this.write(code, length);
  }

  // Ник или текст - см. описание в начале файла
  string(value) {
    const chars = [...String(value ?? '')].slice(0, MAX_TEXT);
    if (chars.length && chars.every((char) => NAME_CHARS.includes(char))) {
      this.write(0, 1);
      this.numberK(chars.length, 3);
      for (const char of chars) this.write(NAME_CHARS.indexOf(char), 6);
      return;
    }
    this.write(1, 1);
    this.numberK(chars.length, 3);
    const capital = chars.length > 0 && upperOf(chars[0]) !== null;
    this.write(capital ? 1 : 0, 1);
    chars.forEach((char, position) => {
      const low = upperOf(char);
      if (TABLE_INDEX.has(char)) {
        this.symbol(TABLE_INDEX.get(char));
      } else if (low !== null) {
        if (!(capital && position === 0)) this.symbol(UPPER);
        this.symbol(TABLE_INDEX.get(low));
      } else {
        this.symbol(RAW);
        this.number(char.codePointAt(0));
      }
    });
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

  numberK(order) {
    return this.number() * 2 ** order + this.read(order);
  }

  // Сколько чего-то в коде. Слишком много - код испорчен
  count(limit = 10000) {
    const value = this.number();
    if (value > limit) throw new CodeError('код повреждён');
    return value;
  }

  symbol() {
    let code = 0;
    for (let length = 1; length <= LONGEST; length++) {
      code = code * 2 + this.read(1);
      const symbol = HUFFMAN.symbols.get(`${length}:${code}`);
      if (symbol !== undefined) return symbol;
    }
    throw new CodeError('код повреждён');
  }

  string() {
    const simple = this.read(1) === 0;
    const length = this.numberK(3);
    if (length > MAX_TEXT) throw new CodeError('код повреждён');
    let text = '';
    if (simple) {
      for (let i = 0; i < length; i++) {
        const value = this.read(6);
        if (value >= NAME_CHARS.length) throw new CodeError('код повреждён');
        text += NAME_CHARS[value];
      }
      return text;
    }
    const capital = this.read(1) === 1;
    for (let i = 0; i < length; i++) {
      let symbol = this.symbol();
      let upper = capital && i === 0;
      if (symbol === UPPER) {
        upper = true;
        symbol = this.symbol();
        if (symbol >= TABLE.length) throw new CodeError('код повреждён');
      }
      if (symbol === RAW) {
        const point = this.number();
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) || upper) throw new CodeError('код повреждён');
        text += String.fromCodePoint(point);
      } else {
        text += upper ? TABLE[symbol].toUpperCase() : TABLE[symbol];
      }
    }
    return text;
  }

  // В конце могут остаться только нули, добивающие последнюю букву
  finish() {
    const rest = this.bits.slice(this.pos);
    if (rest.length >= 6 || rest.some((bit) => bit)) throw new CodeError('в коде лишние данные');
  }
}

// ------------------------------------------------------------ коллекция

function inventoryEntries(items) {
  return [...(items instanceof Map ? items : Object.entries(items || {}))]
    .map(([code, count]) => [Number(code), Number(count)])
    .filter(([code, count]) => code > 0 && count > 0)
    .sort((x, y) => x[0] - y[0]);
}

// Порядок Exp-Golomb, с которым количества (штук - 1) короче всего
function countOrder(counts) {
  let best = 0, bestBits = Infinity;
  for (let order = 0; order < 8; order++) {
    let bits = 0;
    for (const count of counts) {
      const high = Math.floor((count - 1) / 2 ** order);
      bits += 2 * (high ? Math.floor(Math.log2(high)) + 1 : 0) + 1 + order;
    }
    if (bits < bestBits) [best, bestBits] = [order, bits];
  }
  return best;
}

// adaptive - штуки кодом порядка k (ссылка одним кодом), иначе - порядка 0
function writeInventory(writer, items, adaptive) {
  const entries = inventoryEntries(items);
  writer.number(entries.length);
  let order = 0;
  if (adaptive && entries.length) {
    order = countOrder(entries.map(([, count]) => count));
    writer.number(order);
  }
  let previous = 0;
  for (const [code, count] of entries) {
    writer.number(code - previous - 1);
    writer.numberK(count - 1, order);
    previous = code;
  }
}

function readInventory(reader, adaptive) {
  const count = reader.count();
  const order = adaptive && count ? reader.count(7) : 0;
  const items = new Map();
  let previous = 0;
  for (let i = 0; i < count; i++) {
    const code = previous + reader.number() + 1;
    items.set(code, reader.numberK(order) + 1);
    previous = code;
  }
  return items;
}

// items: Map или объект {номер предмета: сколько штук}
export function encodeInventory(items) {
  const writer = new BitWriter();
  writer.write(KIND_INVENTORY, 3);
  writeInventory(writer, items, false);
  return writer.text();
}

// Возвращает Map {номер предмета: сколько штук}
export function decodeInventory(text) {
  const reader = new BitReader(text, KIND_INVENTORY);
  const items = readInventory(reader, false);
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

function writeRoom(writer, placements) {
  const list = [...placements].sort(compare);
  if (list.some((p) => !(p.code >= 1))) throw new CodeError('у предмета нет номера');
  const biggest = Math.max(1, ...list.flatMap((p) => [p.a, p.b]));
  const coordBits = Math.floor(Math.log2(biggest)) + 1;
  if (coordBits > 8) throw new CodeError('комната слишком большая');
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
}

function readRoom(reader) {
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
  return placements;
}

// placements: [{ code, surface: 'floor' | 'left' | 'right', a, b, rot }]
export function encodeRoom(placements) {
  const writer = new BitWriter();
  writer.write(KIND_ROOM, 3);
  writeRoom(writer, placements);
  return writer.text();
}

export function decodeRoom(text) {
  const reader = new BitReader(text, KIND_ROOM);
  const placements = readRoom(reader);
  reader.finish();
  return placements;
}

// ------------------------------------------------------------ гардероб и образ

function writeSet(writer, codes) {
  const list = [...new Set([...codes].map(Number))].sort((x, y) => x - y);
  if (list.some((code) => !(code >= 1))) throw new CodeError('у предмета нет номера');
  writer.number(list.length);
  let previous = 0;
  for (const code of list) {
    writer.number(code - previous - 1);
    previous = code;
  }
}

function readSet(reader) {
  const count = reader.count();
  const codes = [];
  let previous = 0;
  for (let i = 0; i < count; i++) {
    previous = previous + reader.number() + 1;
    codes.push(previous);
  }
  return codes;
}

function encodeSet(kind, codes) {
  const writer = new BitWriter();
  writer.write(kind, 3);
  writeSet(writer, codes);
  return writer.text();
}

function decodeSet(kind, text) {
  const reader = new BitReader(text, kind);
  const codes = readSet(reader);
  reader.finish();
  return codes;
}

// Гардероб: номера одежды, которая есть у зрителя (кроме той, что есть у всех)
export const encodeWardrobe = (codes) => encodeSet(KIND_WARDROBE, codes);
export const decodeWardrobe = (text) => decodeSet(KIND_WARDROBE, text);
// Образ: номера того, что надето, - по одному на слот
export const encodeLook = (codes) => encodeSet(KIND_LOOK, codes);
export const decodeLook = (text) => decodeSet(KIND_LOOK, text);

// ------------------------------------------------------------ ссылка одним кодом

// page - LINK_ROOM, LINK_AVATAR или LINK_GIFTS. parts:
//   комната  - { inventory: мебель, которой нет в комнате (Map или {номер: штук}), room: [placements] };
//   персонаж - { wardrobe: [номера], look: [номера] };
//   подарки  - { inventory: свободная мебель, outfits: [номера] }.
export function encodeLink(page, name, parts = {}) {
  const writer = new BitWriter();
  writer.write(KIND_LINK, 3);
  writer.number(page);
  writer.string(name || '');
  if (page === LINK_ROOM) {
    writeInventory(writer, parts.inventory, true);
    writeRoom(writer, parts.room || []);
  } else if (page === LINK_AVATAR) {
    writeSet(writer, parts.wardrobe || []);
    writeSet(writer, parts.look || []);
  } else if (page === LINK_GIFTS) {
    writeInventory(writer, parts.inventory, true);
    writeSet(writer, parts.outfits || []);
  } else {
    throw new CodeError('неизвестная страница');
  }
  return writer.text();
}

// Код ссылки -> { page, name, inventory: Map, room, wardrobe, look, outfits }
export function decodeLink(text) {
  const reader = new BitReader(text, KIND_LINK);
  const page = reader.number();
  if (![LINK_ROOM, LINK_AVATAR, LINK_GIFTS].includes(page)) {
    throw new CodeError('ссылка на страницу, которой этот сайт не знает, - обнови страницу');
  }
  const link = { page, name: reader.string(), inventory: new Map(), room: [], wardrobe: [], look: [], outfits: [] };
  if (page === LINK_ROOM) {
    link.inventory = readInventory(reader, true);
    link.room = readRoom(reader);
  } else if (page === LINK_AVATAR) {
    link.wardrobe = readSet(reader);
    link.look = readSet(reader);
  } else {
    link.inventory = readInventory(reader, true);
    link.outfits = readSet(reader);
  }
  reader.finish();
  return link;
}

// Что пришло в ссылке после #: ссылка одним кодом или старая - с параметрами.
// Возвращает { name, code, params, link, error }: params - параметры старой
// ссылки (URLSearchParams) или null, link - разобранный код новой или null,
// error - почему код новой ссылки не читается
export function readLink(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw || raw.includes('=')) {
    const params = new URLSearchParams(raw);
    return { name: (params.get('n') || '').trim().slice(0, 40), params, link: null, error: '' };
  }
  try {
    const link = decodeLink(raw);
    return { name: link.name.trim().slice(0, 40), params: null, link, error: '' };
  } catch (error) {
    return { name: '', params: null, link: null, error: error.message };
  }
}
