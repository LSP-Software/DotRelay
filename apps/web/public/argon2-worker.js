(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;

  // ../../packages/client/src/account/argon2-worker.ts
  var exports_argon2_worker = {};

  // ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/utils.js
  function isBytes(a) {
    return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
  }
  var atitle = (title) => title ? `"${title}" ` : "";
  function anumber(n, title = "") {
    if (typeof n !== "number")
      throw new TypeError(atitle(title) + "expected number, got " + typeof n);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
    return n;
  }
  function abytes(value, length, title = "") {
    if (isBytes(value) && (length === undefined || value.length === length))
      return value;
    if (length !== undefined)
      anumber(length, "length");
    const bytes = isBytes(value);
    const ofLen = length !== undefined ? ` of length ${length}` : "";
    const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
    const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
    if (!bytes)
      throw new TypeError(message);
    throw new RangeError(message);
  }
  function copyBytes(bytes) {
    return Uint8Array.from(abytes(bytes));
  }
  var aobject = (value, label) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
  };
  var aopts = (value, label) => {
    aobject(value, label);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw new TypeError(`"${label}" expected plain object`);
    if (Object.hasOwn(value, "__proto__"))
      throw new TypeError(`"${label}.__proto__" is not allowed`);
  };
  function aexists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("hash was destroyed");
    if (checkFinished && instance.finished)
      throw new Error("digest() was already called");
  }
  function aoutput(out, instance) {
    abytes(out, undefined, "output");
    const min = instance.outputLen;
    if (!(out.length >= min)) {
      throw new RangeError('"output" expected length >= ' + min);
    }
  }
  function u8(arr) {
    return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  }
  function u32(arr) {
    return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
  }
  function clean(...arrays) {
    for (let i = 0;i < arrays.length; i++) {
      arrays[i].fill(0);
    }
  }
  var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
  function byteSwap(word) {
    return word << 24 & 4278190080 | word << 8 & 16711680 | word >>> 8 & 65280 | word >>> 24 & 255;
  }
  var swap8IfBE = isLE ? (n) => n : (n) => byteSwap(n) >>> 0;
  function byteSwap32(arr) {
    for (let i = 0;i < arr.length; i++) {
      arr[i] = byteSwap(arr[i]);
    }
    return arr;
  }
  var swap32IfBE = isLE ? (u) => u : byteSwap32;
  function utf8ToBytes(str) {
    if (typeof str !== "string")
      throw new TypeError("string expected");
    const encoded = new TextEncoder().encode(str);
    try {
      return new Uint8Array(encoded);
    } finally {
      clean(encoded);
    }
  }
  function kdfInputToBytes(data, errorTitle = "") {
    if (typeof data === "string")
      return utf8ToBytes(data);
    return abytes(data, undefined, errorTitle);
  }
  function checkOpts(defaults, opts, title = "opts") {
    aopts(defaults, "defaults");
    if (opts !== undefined)
      aopts(opts, title);
    const merged = Object.assign(Object.create(null), defaults, opts);
    return merged;
  }
  function createHasher(hashCons, info = {}) {
    if (typeof hashCons !== "function")
      throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
    info = checkOpts({}, info, "info");
    const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
    const tmp = hashCons(undefined);
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.canXOF = tmp.canXOF;
    hashC.create = (opts) => hashCons(opts);
    Object.assign(hashC, info);
    return Object.freeze(hashC);
  }

  // ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/_blake.js
  var BSIGMA = /* @__PURE__ */ Uint8Array.from([
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    14,
    10,
    4,
    8,
    9,
    15,
    13,
    6,
    1,
    12,
    0,
    2,
    11,
    7,
    5,
    3,
    11,
    8,
    12,
    0,
    5,
    2,
    15,
    13,
    10,
    14,
    3,
    6,
    7,
    1,
    9,
    4,
    7,
    9,
    3,
    1,
    13,
    12,
    11,
    14,
    2,
    6,
    5,
    10,
    4,
    0,
    15,
    8,
    9,
    0,
    5,
    7,
    2,
    4,
    10,
    15,
    14,
    1,
    11,
    12,
    6,
    8,
    3,
    13,
    2,
    12,
    6,
    10,
    0,
    11,
    8,
    3,
    4,
    13,
    7,
    5,
    15,
    14,
    1,
    9,
    12,
    5,
    1,
    15,
    14,
    13,
    4,
    10,
    0,
    7,
    6,
    3,
    9,
    2,
    8,
    11,
    13,
    11,
    7,
    14,
    12,
    1,
    3,
    9,
    5,
    0,
    15,
    4,
    8,
    6,
    2,
    10,
    6,
    15,
    14,
    9,
    11,
    3,
    0,
    8,
    12,
    2,
    13,
    7,
    1,
    4,
    10,
    5,
    10,
    2,
    8,
    4,
    7,
    6,
    1,
    5,
    15,
    11,
    9,
    14,
    3,
    12,
    13,
    0,
    0,
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    12,
    13,
    14,
    15,
    14,
    10,
    4,
    8,
    9,
    15,
    13,
    6,
    1,
    12,
    0,
    2,
    11,
    7,
    5,
    3,
    11,
    8,
    12,
    0,
    5,
    2,
    15,
    13,
    10,
    14,
    3,
    6,
    7,
    1,
    9,
    4,
    7,
    9,
    3,
    1,
    13,
    12,
    11,
    14,
    2,
    6,
    5,
    10,
    4,
    0,
    15,
    8,
    9,
    0,
    5,
    7,
    2,
    4,
    10,
    15,
    14,
    1,
    11,
    12,
    6,
    8,
    3,
    13,
    2,
    12,
    6,
    10,
    0,
    11,
    8,
    3,
    4,
    13,
    7,
    5,
    15,
    14,
    1,
    9
  ]);

  // ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/_u64.js
  var fromNumH = (n) => n / 2 ** 32 | 0;
  var fromNumL = (n) => n >>> 0;
  var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
  var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
  var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
  var rotr32H = (_h, l) => l;
  var rotr32L = (h, _l) => h;
  function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
  }
  var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
  var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;

  // ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/blake2.js
  var B2B_IV = /* @__PURE__ */ Uint32Array.from([
    4089235720,
    1779033703,
    2227873595,
    3144134277,
    4271175723,
    1013904242,
    1595750129,
    2773480762,
    2917565137,
    1359893119,
    725511199,
    2600822924,
    4215389547,
    528734635,
    327033209,
    1541459225
  ]);
  var BBUF = /* @__PURE__ */ new Uint32Array(32);
  function G1b(a, b, c, d, msg, x) {
    const Xl = msg[x], Xh = msg[x + 1];
    let Al = BBUF[2 * a], Ah = BBUF[2 * a + 1];
    let Bl = BBUF[2 * b], Bh = BBUF[2 * b + 1];
    let Cl = BBUF[2 * c], Ch = BBUF[2 * c + 1];
    let Dl = BBUF[2 * d], Dh = BBUF[2 * d + 1];
    const ll = add3L(Al, Bl, Xl);
    Ah = add3H(ll, Ah, Bh, Xh);
    Al = ll | 0;
    let xh = Dh ^ Ah, xl = Dl ^ Al;
    Dh = rotr32H(xh, xl);
    Dl = rotr32L(xh, xl);
    ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
    xh = Bh ^ Ch;
    xl = Bl ^ Cl;
    Bh = rotrSH(xh, xl, 24);
    Bl = rotrSL(xh, xl, 24);
    BBUF[2 * a] = Al;
    BBUF[2 * a + 1] = Ah;
    BBUF[2 * b] = Bl;
    BBUF[2 * b + 1] = Bh;
    BBUF[2 * c] = Cl;
    BBUF[2 * c + 1] = Ch;
    BBUF[2 * d] = Dl;
    BBUF[2 * d + 1] = Dh;
  }
  function G2b(a, b, c, d, msg, x) {
    const Xl = msg[x], Xh = msg[x + 1];
    let Al = BBUF[2 * a], Ah = BBUF[2 * a + 1];
    let Bl = BBUF[2 * b], Bh = BBUF[2 * b + 1];
    let Cl = BBUF[2 * c], Ch = BBUF[2 * c + 1];
    let Dl = BBUF[2 * d], Dh = BBUF[2 * d + 1];
    const ll = add3L(Al, Bl, Xl);
    Ah = add3H(ll, Ah, Bh, Xh);
    Al = ll | 0;
    let xh = Dh ^ Ah, xl = Dl ^ Al;
    Dh = rotrSH(xh, xl, 16);
    Dl = rotrSL(xh, xl, 16);
    ({ h: Ch, l: Cl } = add(Ch, Cl, Dh, Dl));
    xh = Bh ^ Ch;
    xl = Bl ^ Cl;
    Bh = rotrBH(xh, xl, 63);
    Bl = rotrBL(xh, xl, 63);
    BBUF[2 * a] = Al;
    BBUF[2 * a + 1] = Ah;
    BBUF[2 * b] = Bl;
    BBUF[2 * b + 1] = Bh;
    BBUF[2 * c] = Cl;
    BBUF[2 * c + 1] = Ch;
    BBUF[2 * d] = Dl;
    BBUF[2 * d + 1] = Dh;
  }
  function checkBlake2Opts(outputLen, opts = {}, keyLen, saltLen, persLen) {
    anumber(keyLen);
    if (outputLen <= 0 || outputLen > keyLen)
      throw new Error('"dkLen" must be 1..' + keyLen + ", got " + outputLen);
    const { key, salt, personalization } = opts;
    if (key !== undefined && (key.length < 1 || key.length > keyLen))
      throw new Error('"key" expected to be undefined or of length=1..' + keyLen);
    if (salt !== undefined)
      abytes(salt, saltLen, "salt");
    if (personalization !== undefined)
      abytes(personalization, persLen, "personalization");
  }

  class _BLAKE2 {
    buffer;
    buffer32;
    finished = false;
    destroyed = false;
    length = 0;
    pos = 0;
    blockLen;
    outputLen;
    canXOF = false;
    constructor(blockLen, outputLen) {
      anumber(blockLen);
      anumber(outputLen);
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.buffer = new Uint8Array(blockLen);
      this.buffer32 = u32(this.buffer);
    }
    update(data) {
      aexists(this);
      abytes(data);
      const { blockLen, buffer, buffer32 } = this;
      const len = data.length;
      const offset = data.byteOffset;
      const buf = data.buffer;
      for (let pos = 0;pos < len; ) {
        if (this.pos === blockLen) {
          swap32IfBE(buffer32);
          this.compress(buffer32, 0, false);
          swap32IfBE(buffer32);
          this.pos = 0;
        }
        const take = Math.min(blockLen - this.pos, len - pos);
        const dataOffset = offset + pos;
        if (take === blockLen && !(dataOffset % 4) && pos + take < len) {
          const data32 = new Uint32Array(buf, dataOffset, Math.floor((len - pos) / 4));
          swap32IfBE(data32);
          for (let pos32 = 0;pos + blockLen < len; pos32 += buffer32.length, pos += blockLen) {
            this.length += blockLen;
            this.compress(data32, pos32, false);
          }
          swap32IfBE(data32);
          continue;
        }
        buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        this.length += take;
        pos += take;
      }
      return this;
    }
    digestInto(out) {
      aexists(this);
      aoutput(out, this);
      if (out.byteOffset & 3)
        throw new RangeError('"output" expected 4-byte aligned byteOffset, got ' + out.byteOffset);
      const { pos, buffer32 } = this;
      this.finished = true;
      this.buffer.fill(0, pos);
      swap32IfBE(buffer32);
      this.compress(buffer32, 0, true);
      swap32IfBE(buffer32);
      const state = this.get();
      const out32 = out === this.buffer ? buffer32 : u32(out);
      const full = Math.floor(this.outputLen / 4);
      for (let i = 0;i < full; i++)
        out32[i] = swap8IfBE(state[i]);
      const tail = this.outputLen % 4;
      if (!tail)
        return;
      const off = full * 4;
      const word = state[full];
      for (let i = 0;i < tail; i++)
        out[off + i] = word >>> 8 * i;
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      const { buffer, length, finished, destroyed, outputLen, pos } = this;
      to ||= new this.constructor({ dkLen: outputLen });
      to.set(...this.get());
      to.buffer.set(buffer);
      to.destroyed = destroyed;
      to.finished = finished;
      to.length = length;
      to.pos = pos;
      to.outputLen = outputLen;
      return to;
    }
    clone() {
      return this._cloneInto();
    }
  }

  class _BLAKE2b extends _BLAKE2 {
    v0l = B2B_IV[0] | 0;
    v0h = B2B_IV[1] | 0;
    v1l = B2B_IV[2] | 0;
    v1h = B2B_IV[3] | 0;
    v2l = B2B_IV[4] | 0;
    v2h = B2B_IV[5] | 0;
    v3l = B2B_IV[6] | 0;
    v3h = B2B_IV[7] | 0;
    v4l = B2B_IV[8] | 0;
    v4h = B2B_IV[9] | 0;
    v5l = B2B_IV[10] | 0;
    v5h = B2B_IV[11] | 0;
    v6l = B2B_IV[12] | 0;
    v6h = B2B_IV[13] | 0;
    v7l = B2B_IV[14] | 0;
    v7h = B2B_IV[15] | 0;
    constructor(opts = {}) {
      opts = checkOpts({}, opts);
      const olen = opts.dkLen === undefined ? 64 : opts.dkLen;
      super(128, olen);
      checkBlake2Opts(olen, opts, 64, 16, 16);
      let { key, personalization, salt } = opts;
      let keyLength = 0;
      if (key !== undefined) {
        abytes(key, undefined, "key");
        keyLength = key.length;
      }
      this.v0l ^= this.outputLen | keyLength << 8 | 1 << 16 | 1 << 24;
      if (salt !== undefined) {
        abytes(salt, undefined, "salt");
        const slt = u32(copyBytes(salt));
        this.v4l ^= swap8IfBE(slt[0]);
        this.v4h ^= swap8IfBE(slt[1]);
        this.v5l ^= swap8IfBE(slt[2]);
        this.v5h ^= swap8IfBE(slt[3]);
      }
      if (personalization !== undefined) {
        abytes(personalization, undefined, "personalization");
        const pers = u32(copyBytes(personalization));
        this.v6l ^= swap8IfBE(pers[0]);
        this.v6h ^= swap8IfBE(pers[1]);
        this.v7l ^= swap8IfBE(pers[2]);
        this.v7h ^= swap8IfBE(pers[3]);
      }
      if (key !== undefined) {
        const tmp = new Uint8Array(this.blockLen);
        tmp.set(key);
        this.update(tmp);
        clean(tmp);
      }
    }
    get() {
      let { v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h } = this;
      return [v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h];
    }
    set(v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h) {
      this.v0l = v0l | 0;
      this.v0h = v0h | 0;
      this.v1l = v1l | 0;
      this.v1h = v1h | 0;
      this.v2l = v2l | 0;
      this.v2h = v2h | 0;
      this.v3l = v3l | 0;
      this.v3h = v3h | 0;
      this.v4l = v4l | 0;
      this.v4h = v4h | 0;
      this.v5l = v5l | 0;
      this.v5h = v5h | 0;
      this.v6l = v6l | 0;
      this.v6h = v6h | 0;
      this.v7l = v7l | 0;
      this.v7h = v7h | 0;
    }
    compress(msg, offset, isLast) {
      const { v0l, v0h, v1l, v1h, v2l, v2h, v3l, v3h, v4l, v4h, v5l, v5h, v6l, v6h, v7l, v7h } = this;
      {
        BBUF[0] = v0l;
        BBUF[1] = v0h;
        BBUF[2] = v1l;
        BBUF[3] = v1h;
        BBUF[4] = v2l;
        BBUF[5] = v2h;
        BBUF[6] = v3l;
        BBUF[7] = v3h;
        BBUF[8] = v4l;
        BBUF[9] = v4h;
        BBUF[10] = v5l;
        BBUF[11] = v5h;
        BBUF[12] = v6l;
        BBUF[13] = v6h;
        BBUF[14] = v7l;
        BBUF[15] = v7h;
      }
      BBUF.set(B2B_IV, 16);
      const l = fromNumL(this.length);
      const h = fromNumH(this.length);
      BBUF[24] = B2B_IV[8] ^ l;
      BBUF[25] = B2B_IV[9] ^ h;
      if (isLast) {
        BBUF[28] = ~BBUF[28];
        BBUF[29] = ~BBUF[29];
      }
      let j = 0;
      const s = BSIGMA;
      for (let i = 0;i < 12; i++) {
        G1b(0, 4, 8, 12, msg, offset + 2 * s[j++]);
        G2b(0, 4, 8, 12, msg, offset + 2 * s[j++]);
        G1b(1, 5, 9, 13, msg, offset + 2 * s[j++]);
        G2b(1, 5, 9, 13, msg, offset + 2 * s[j++]);
        G1b(2, 6, 10, 14, msg, offset + 2 * s[j++]);
        G2b(2, 6, 10, 14, msg, offset + 2 * s[j++]);
        G1b(3, 7, 11, 15, msg, offset + 2 * s[j++]);
        G2b(3, 7, 11, 15, msg, offset + 2 * s[j++]);
        G1b(0, 5, 10, 15, msg, offset + 2 * s[j++]);
        G2b(0, 5, 10, 15, msg, offset + 2 * s[j++]);
        G1b(1, 6, 11, 12, msg, offset + 2 * s[j++]);
        G2b(1, 6, 11, 12, msg, offset + 2 * s[j++]);
        G1b(2, 7, 8, 13, msg, offset + 2 * s[j++]);
        G2b(2, 7, 8, 13, msg, offset + 2 * s[j++]);
        G1b(3, 4, 9, 14, msg, offset + 2 * s[j++]);
        G2b(3, 4, 9, 14, msg, offset + 2 * s[j++]);
      }
      this.v0l ^= BBUF[0] ^ BBUF[16];
      this.v0h ^= BBUF[1] ^ BBUF[17];
      this.v1l ^= BBUF[2] ^ BBUF[18];
      this.v1h ^= BBUF[3] ^ BBUF[19];
      this.v2l ^= BBUF[4] ^ BBUF[20];
      this.v2h ^= BBUF[5] ^ BBUF[21];
      this.v3l ^= BBUF[6] ^ BBUF[22];
      this.v3h ^= BBUF[7] ^ BBUF[23];
      this.v4l ^= BBUF[8] ^ BBUF[24];
      this.v4h ^= BBUF[9] ^ BBUF[25];
      this.v5l ^= BBUF[10] ^ BBUF[26];
      this.v5h ^= BBUF[11] ^ BBUF[27];
      this.v6l ^= BBUF[12] ^ BBUF[28];
      this.v6h ^= BBUF[13] ^ BBUF[29];
      this.v7l ^= BBUF[14] ^ BBUF[30];
      this.v7h ^= BBUF[15] ^ BBUF[31];
      clean(BBUF);
    }
    destroy() {
      this.destroyed = true;
      clean(this.buffer32);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  var blake2b = /* @__PURE__ */ createHasher((opts) => new _BLAKE2b(opts));

  // ../../node_modules/.bun/@noble+hashes@2.4.0/node_modules/@noble/hashes/argon2.js
  var AT = { Argon2d: 0, Argon2i: 1, Argon2id: 2 };
  var ARGON2_SYNC_POINTS = 4;
  var abytesOrZero = (buf, errorTitle = "") => {
    if (buf === undefined)
      return Uint8Array.of();
    return kdfInputToBytes(buf, errorTitle);
  };
  var A2_BUF = new Uint32Array(256);
  function G(a, b, c, d) {
    let Al = A2_BUF[2 * a], Ah = A2_BUF[2 * a + 1];
    let Bl = A2_BUF[2 * b], Bh = A2_BUF[2 * b + 1];
    let Cl = A2_BUF[2 * c], Ch = A2_BUF[2 * c + 1];
    let Dl = A2_BUF[2 * d], Dh = A2_BUF[2 * d + 1];
    let ml = 0, mh = 0, rl = 0, xh = 0, xl = 0;
    ml = Math.imul(Al, Bl);
    mh = ((Al >>> 0) * (Bl >>> 0) - (ml >>> 0)) / 4294967296 + 0.5 | 0;
    rl = (Al >>> 0) + (Bl >>> 0) + (ml << 1 >>> 0);
    Ah = Ah + Bh + (mh << 1 | ml >>> 31) + (rl / 4294967296 | 0) | 0;
    Al = rl | 0;
    xh = Dh ^ Ah;
    xl = Dl ^ Al;
    Dh = xl;
    Dl = xh;
    ml = Math.imul(Cl, Dl);
    mh = ((Cl >>> 0) * (Dl >>> 0) - (ml >>> 0)) / 4294967296 + 0.5 | 0;
    rl = (Cl >>> 0) + (Dl >>> 0) + (ml << 1 >>> 0);
    Ch = Ch + Dh + (mh << 1 | ml >>> 31) + (rl / 4294967296 | 0) | 0;
    Cl = rl | 0;
    xh = Bh ^ Ch;
    xl = Bl ^ Cl;
    Bh = xh >>> 24 | xl << 8;
    Bl = xh << 8 | xl >>> 24;
    ml = Math.imul(Al, Bl);
    mh = ((Al >>> 0) * (Bl >>> 0) - (ml >>> 0)) / 4294967296 + 0.5 | 0;
    rl = (Al >>> 0) + (Bl >>> 0) + (ml << 1 >>> 0);
    Ah = Ah + Bh + (mh << 1 | ml >>> 31) + (rl / 4294967296 | 0) | 0;
    Al = rl | 0;
    xh = Dh ^ Ah;
    xl = Dl ^ Al;
    Dh = xh >>> 16 | xl << 16;
    Dl = xh << 16 | xl >>> 16;
    ml = Math.imul(Cl, Dl);
    mh = ((Cl >>> 0) * (Dl >>> 0) - (ml >>> 0)) / 4294967296 + 0.5 | 0;
    rl = (Cl >>> 0) + (Dl >>> 0) + (ml << 1 >>> 0);
    Ch = Ch + Dh + (mh << 1 | ml >>> 31) + (rl / 4294967296 | 0) | 0;
    Cl = rl | 0;
    xh = Bh ^ Ch;
    xl = Bl ^ Cl;
    Bh = xh << 1 | xl >>> 31;
    Bl = xh >>> 31 | xl << 1;
    A2_BUF[2 * a] = Al, A2_BUF[2 * a + 1] = Ah;
    A2_BUF[2 * b] = Bl, A2_BUF[2 * b + 1] = Bh;
    A2_BUF[2 * c] = Cl, A2_BUF[2 * c + 1] = Ch;
    A2_BUF[2 * d] = Dl, A2_BUF[2 * d + 1] = Dh;
  }
  function P(v00, v01, v02, v03, v04, v05, v06, v07, v08, v09, v10, v11, v12, v13, v14, v15) {
    G(v00, v04, v08, v12);
    G(v01, v05, v09, v13);
    G(v02, v06, v10, v14);
    G(v03, v07, v11, v15);
    G(v00, v05, v10, v15);
    G(v01, v06, v11, v12);
    G(v02, v07, v08, v13);
    G(v03, v04, v09, v14);
  }
  function block(x, xPos, yPos, outPos, needXor) {
    if (needXor) {
      for (let i = 0;i < 256; i++) {
        const r = x[xPos + i] ^ x[yPos + i];
        A2_BUF[i] = r;
        x[outPos + i] ^= r;
      }
    } else {
      for (let i = 0;i < 256; i++) {
        const r = x[xPos + i] ^ x[yPos + i];
        A2_BUF[i] = r;
        x[outPos + i] = r;
      }
    }
    for (let i = 0;i < 128; i += 16) {
      P(i, i + 1, i + 2, i + 3, i + 4, i + 5, i + 6, i + 7, i + 8, i + 9, i + 10, i + 11, i + 12, i + 13, i + 14, i + 15);
    }
    for (let i = 0;i < 16; i += 2) {
      P(i, i + 1, i + 16, i + 17, i + 32, i + 33, i + 48, i + 49, i + 64, i + 65, i + 80, i + 81, i + 96, i + 97, i + 112, i + 113);
    }
    for (let i = 0;i < 256; i++)
      x[outPos + i] ^= A2_BUF[i];
    clean(A2_BUF);
  }
  function Hp(A, dkLen) {
    const A8 = u8(A);
    const T = new Uint32Array(1);
    const T8 = u8(T);
    T[0] = swap8IfBE(dkLen);
    if (dkLen <= 64)
      return blake2b.create({ dkLen }).update(T8).update(A8).digest();
    const out = new Uint8Array(dkLen);
    let V = blake2b.create({}).update(T8).update(A8).digest();
    let pos = 0;
    out.set(V.subarray(0, 32));
    pos += 32;
    for (;dkLen - pos > 64; pos += 32) {
      const Vh = blake2b.create({}).update(V);
      Vh.digestInto(V);
      Vh.destroy();
      out.set(V.subarray(0, 32), pos);
    }
    out.set(blake2b(V, { dkLen: dkLen - pos }), pos);
    clean(V, T);
    return out;
  }
  function indexAlpha(r, s, laneLen, segmentLen, index, randL, sameLane = false) {
    let area;
    if (r === 0) {
      if (s === 0)
        area = index - 1;
      else if (sameLane)
        area = s * segmentLen + index - 1;
      else
        area = s * segmentLen + (index == 0 ? -1 : 0);
    } else if (sameLane)
      area = laneLen - segmentLen + index - 1;
    else
      area = laneLen - segmentLen + (index == 0 ? -1 : 0);
    const startPos = r !== 0 && s !== ARGON2_SYNC_POINTS - 1 ? (s + 1) * segmentLen : 0;
    const randLow = Math.imul(randL, randL);
    const randHigh = ((randL >>> 0) * (randL >>> 0) - (randLow >>> 0)) / 4294967296 + 0.5 | 0;
    const areaLow = Math.imul(area, randHigh);
    const areaHigh = ((area >>> 0) * (randHigh >>> 0) - (areaLow >>> 0)) / 4294967296 + 0.5 | 0;
    const rel = area - 1 - areaHigh;
    return (startPos + rel) % laneLen;
  }
  var maxUint32 = Math.pow(2, 32);
  var ARGON2_DEFAULT_MEMORY = 1024 ** 2;
  var ARGON2_DEFAULT_MAXMEM = ARGON2_DEFAULT_MEMORY * 1024;
  function isU32(num) {
    return Number.isSafeInteger(num) && num >= 0 && num < maxUint32;
  }
  function argon2Opts(opts = {}) {
    opts = checkOpts({}, opts);
    const merged = {
      t: 3,
      m: ARGON2_DEFAULT_MEMORY,
      p: 1,
      version: 19,
      dkLen: 32,
      maxmem: ARGON2_DEFAULT_MAXMEM,
      asyncTick: 10
    };
    for (let [k, v] of Object.entries(opts))
      if (v !== undefined)
        merged[k] = v;
    const { dkLen, p, m, t, version, onProgress, asyncTick } = merged;
    if (!isU32(dkLen) || dkLen < 4)
      throw new Error('"dkLen" must be 4..');
    if (!isU32(p) || p < 1 || p >= Math.pow(2, 24))
      throw new Error('"p" must be 1..2^24');
    if (!isU32(m))
      throw new Error('"m" must be 0..2^32');
    if (!isU32(t) || t < 1)
      throw new Error('"t" (iterations) must be 1..2^32');
    if (onProgress !== undefined && typeof onProgress !== "function")
      throw new Error('"onProgress" must be a function');
    anumber(asyncTick, "asyncTick");
    if (!isU32(m) || m < 8 * p)
      throw new Error('"m" (memory) must be at least 8*p bytes');
    if (version !== 16 && version !== 19)
      throw new Error('"version" must be 0x10 or 0x13, got ' + version);
    return merged;
  }
  function argon2InitialHash(password, salt, type, opts) {
    const ownedInputs = [];
    const BUF = new Uint32Array(1);
    const BUF8 = u8(BUF);
    let h;
    let H0;
    let succeeded = false;
    const rememberOwned = (input, bytes) => {
      if (typeof input === "string")
        ownedInputs.push(bytes);
      return bytes;
    };
    try {
      const passwordBytes = rememberOwned(password, kdfInputToBytes(password, "password"));
      const saltBytes = rememberOwned(salt, kdfInputToBytes(salt, "salt"));
      if (!isU32(passwordBytes.length))
        throw new Error('"password" must be less of length 1..4Gb');
      if (!isU32(saltBytes.length) || saltBytes.length < 8)
        throw new Error('"salt" must be of length 8..4Gb');
      if (!Object.values(AT).includes(type))
        throw new Error('"type" was invalid');
      let { p, dkLen, m, t, version, key, personalization, maxmem, onProgress, asyncTick } = argon2Opts(opts);
      const keyInput = key;
      key = rememberOwned(keyInput, abytesOrZero(keyInput, "key"));
      const personalizationInput = personalization;
      personalization = rememberOwned(personalizationInput, abytesOrZero(personalizationInput, "personalization"));
      h = blake2b.create();
      for (let item of [p, dkLen, m, t, version, type]) {
        BUF[0] = swap8IfBE(item);
        h.update(BUF8);
      }
      for (let i of [passwordBytes, saltBytes, key, personalization]) {
        BUF[0] = swap8IfBE(i.length);
        h.update(BUF8).update(i);
      }
      H0 = new Uint32Array(18);
      h.digestInto(u8(H0));
      succeeded = true;
      return { H0, p, dkLen, m, t, version, maxmem, onProgress, asyncTick };
    } finally {
      if (h)
        h.destroy();
      clean(BUF, ...ownedInputs);
      if (!succeeded && H0)
        clean(H0);
    }
  }
  function argon2Init(password, salt, type, opts) {
    const { H0, p, dkLen, m, t, version, maxmem, onProgress, asyncTick } = argon2InitialHash(password, salt, type, opts);
    try {
      const lanes = p;
      const mP = 4 * p * Math.floor(m / (ARGON2_SYNC_POINTS * p));
      const laneLen = Math.floor(mP / p);
      const segmentLen = Math.floor(laneLen / ARGON2_SYNC_POINTS);
      const memUsed = mP * 1024;
      if (!isU32(maxmem))
        throw new Error('"maxmem" expected <2**32, got ' + maxmem);
      if (memUsed > maxmem)
        throw new Error('"maxmem" limit was hit: memUsed(mP*1024)=' + memUsed + ", maxmem=" + maxmem);
      const B = new Uint32Array(memUsed / 4);
      for (let l = 0;l < p; l++) {
        const i = 256 * laneLen * l;
        H0[17] = swap8IfBE(l);
        H0[16] = swap8IfBE(0);
        B.set(swap32IfBE(u32(Hp(H0, 1024))), i);
        H0[16] = swap8IfBE(1);
        B.set(swap32IfBE(u32(Hp(H0, 1024))), i + 256);
      }
      let perBlock = () => {};
      if (onProgress) {
        const totalBlock = t * ARGON2_SYNC_POINTS * p * segmentLen - 2 * p;
        const callbackPer = Math.max(Math.floor(totalBlock / 1e4), 1);
        let blockCnt = 0;
        perBlock = () => {
          blockCnt++;
          if (onProgress && (!(blockCnt % callbackPer) || blockCnt === totalBlock))
            onProgress(blockCnt / totalBlock);
        };
      }
      return { type, mP, p, t, version, B, laneLen, lanes, segmentLen, dkLen, perBlock, asyncTick };
    } finally {
      clean(H0);
    }
  }
  function argon2Output(B, p, laneLen, dkLen) {
    const B_final = new Uint32Array(256);
    for (let l = 0;l < p; l++)
      for (let j = 0;j < 256; j++)
        B_final[j] ^= B[256 * (laneLen * l + laneLen - 1) + j];
    const res = Hp(swap32IfBE(B_final), dkLen);
    clean(B, B_final);
    return res;
  }
  function* argon2Blocks(ctx, address) {
    const { type, mP, p, t, version, B, laneLen, lanes, segmentLen, perBlock } = ctx;
    address[256 + 6] = mP;
    address[256 + 8] = t;
    address[256 + 10] = type;
    for (let r = 0;r < t; r++) {
      const needXor = r !== 0 && version === 19;
      address[256 + 0] = r;
      for (let s = 0;s < ARGON2_SYNC_POINTS; s++) {
        address[256 + 4] = s;
        const dataIndependent = type == AT.Argon2i || type == AT.Argon2id && r === 0 && s < 2;
        for (let l = 0;l < p; l++) {
          address[256 + 2] = l;
          address[256 + 12] = 0;
          let startPos = 0;
          if (r === 0 && s === 0) {
            startPos = 2;
            if (dataIndependent) {
              address[256 + 12]++;
              block(address, 256, 2 * 256, 0, false);
              block(address, 0, 2 * 256, 0, false);
            }
          }
          let offset = l * laneLen + s * segmentLen + startPos;
          for (let index = startPos;index < segmentLen; index++, offset++) {
            perBlock();
            const prev = offset % laneLen ? offset - 1 : offset + laneLen - 1;
            let randL, randH;
            if (dataIndependent) {
              let i128 = index % 128;
              if (i128 === 0) {
                address[256 + 12]++;
                block(address, 256, 2 * 256, 0, false);
                block(address, 0, 2 * 256, 0, false);
              }
              randL = address[2 * i128];
              randH = address[2 * i128 + 1];
            } else {
              const T = 256 * prev;
              randL = B[T];
              randH = B[T + 1];
            }
            const refLane = r === 0 && s === 0 ? l : randH % lanes;
            const refPos = indexAlpha(r, s, laneLen, segmentLen, index, randL, refLane == l);
            const refBlock = laneLen * refLane + refPos;
            block(B, 256 * prev, 256 * refBlock, offset * 256, needXor);
            yield;
          }
        }
      }
    }
    clean(address);
  }
  function argon2(type, password, salt, opts) {
    const ctx = argon2Init(password, salt, type, opts);
    const blocks = argon2Blocks(ctx, new Uint32Array(3 * 256));
    while (!blocks.next().done) {}
    return argon2Output(ctx.B, ctx.p, ctx.laneLen, ctx.dkLen);
  }
  var argon2id = (password, salt, opts = {}) => argon2(AT.Argon2id, password, salt, opts);

  // ../../packages/client/src/account/argon2-worker.ts
  var scope = globalThis;
  scope.onmessage = (event) => {
    const { id, password, salt, params } = event.data;
    const ikm = argon2id(password, salt, {
      t: params.iterations,
      m: params.memoryKiB,
      p: params.parallelism,
      dkLen: 32
    });
    scope.postMessage({ id, ikm }, [ikm.buffer]);
  };
})();
