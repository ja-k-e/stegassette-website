"use strict";
// ============================================================
// steg-core.js — shared pure-JS logic for stegassette STGC format
// Works in Node.js (≥18) and the browser (script-tag global).
//
// STGC binary layout
// ------------------
// Pixel (0,0) alpha       : borderWidth B low byte; 0 = sentinel for 2-byte B
//   If alpha(0,0)=0: bpx[1].alpha = B & 0xff, bpx[2].alpha = (B>>8) & 0xff
//   Otherwise:       B = alpha(0,0)  [backward compatible for B 1-255]
// Bottom row, centered    : STGC header bytes in alpha channel (58-80 bytes max)
// All other border pixels : alpha preserved from source image (opaque)
// Interior pixels         : entry table + concatenated payloads (RGB, under combine op)
// Interior alpha          : always 255
//
// STGC header bytes (alpha of bottom row pixels, centered):
//   0-3  magic "STGC"  (0x53 0x54 0x47 0x43)
//   4    version = 1
//   5-8  interiorByteLength UInt32LE
//   9    entryCount UInt8
//   10   descLen UInt8  (always < 256; byte 11 reserved = 0)
//   11   reserved = 0
//   12+  descriptor: \x01-separated "key=value" pairs
//   last XOR checksum of all preceding header bytes
//
// Zero bytes are clamped to 1 on encode; XOR checksum enables recovery on decode.
//
// Interior stream (each entry in entry table):
//   2    mimetypeLen UInt16LE
//   M    mimetype ASCII
//   2    nameLen UInt16LE
//   N    name UTF-8
//   4    payloadLen UInt32LE
// Payloads follow the table, concatenated in entry order.
// ============================================================

const StegCore = (() => {
  // CODEC_VERSION identifies this *implementation*, not the on-disk format
  // (that's STGC_VERSION). Bump it on any change to encode/decode behaviour.
  // Consumers that vendor a copy of this file log it on boot, so a stale copy
  // is visible in the console instead of silently decoding wrong. Compare
  // copies across repos with `npm run codec:check`.
  const CODEC_VERSION = "2026.07.29";

  // ---- Img class (Buffer, Uint8Array, Uint8ClampedArray) -----
  class Img {
    constructor(width, height, data) {
      this.width = width;
      this.height = height;
      this.data =
        data instanceof Uint8Array
          ? data
          : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data); // Buffer, Uint8ClampedArray, etc.
    }
    get(x, y) {
      x = Math.max(0, Math.min(this.width - 1, x | 0));
      y = Math.max(0, Math.min(this.height - 1, y | 0));
      const o = (y * this.width + x) * 4;
      return [this.data[o], this.data[o + 1], this.data[o + 2]];
    }
    set(x, y, r, g, b) {
      const o = (y * this.width + x) * 4;
      this.data[o] = r;
      this.data[o + 1] = g;
      this.data[o + 2] = b;
      this.data[o + 3] = 255;
    }
    getAlpha(x, y) {
      x = Math.max(0, Math.min(this.width - 1, x | 0));
      y = Math.max(0, Math.min(this.height - 1, y | 0));
      return this.data[(y * this.width + x) * 4 + 3];
    }
    setAlpha(x, y, a) {
      this.data[(y * this.width + x) * 4 + 3] = a & 0xff;
    }
  }

  // ---- pixel classification ----------------------------------
  function isDataPixel(x, y) {
    return y % 2 === 0 ? x % 2 === 1 : x % 2 === 0;
  }
  function isBorderPixel(x, y, W, H, B) {
    return x < B || x >= W - B || y < B || y >= H - B;
  }

  function getBorderPixels(W, H, B) {
    const px = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (isBorderPixel(x, y, W, H, B)) px.push([x, y]);
    return px;
  }

  // ---- capacity helpers -------------------------------------
  // Even rows carry the odd x's, odd rows the even x's. The previous form
  // (floor(W/2)*H + ceil(H/2) when W was odd) over-counted by one whenever
  // BOTH dimensions were odd. Paths are allocated at this size, so the spare
  // slot stayed 0 — a phantom entry pointing at interior (0,0), which is a KEY
  // pixel. Sorted traversals (angle, bayer, polar) sorted it to the front and
  // shifted the entire path. Matches @amplib/steganography.
  function dataPixelCount(W, H) {
    return (
      Math.floor(W / 2) * Math.ceil(H / 2) +
      Math.ceil(W / 2) * Math.floor(H / 2)
    );
  }
  function borderPixelCount(W, H, B) {
    return W * H - (W - 2 * B) * (H - 2 * B);
  }

  // ---- keymaps (local interior coords: lx = x-B, ly = y-B) --
  const KEYMAP_NAMES = ["adjacent", "poles", "mirror-x", "mirror-y", "offset", "rotate"];

  // Snap a target to the nearest IN-INTERIOR key pixel. Keys must never land on
  // the border ring: the header rewrites ring alpha, and canvases
  // premultiply-round the RGB of any pixel with alpha < 255, silently
  // corrupting whatever bytes were keyed against it. Stepping ±1 in x without
  // a bounds check (as this did) keyed the first and last column of every row
  // against the ring. Matches @amplib/steganography.
  function snapToKey(px, py, IW, IH) {
    if (!isDataPixel(px, py)) return [px, py];
    const inRow = py % 2 === 0 ? px - 1 : px + 1;
    if (inRow >= 0 && inRow < IW) return [inRow, py];
    // Orphan: this column has no in-row partner, which happens to the last
    // column of every odd row on an odd-width interior. Step a row instead —
    // the checkerboard parity flips, so the same column is a key pixel there,
    // and it is one no other data pixel claims (on the neighbouring row the
    // keys run 0, 2, … IW-3). Reflecting back in-row would instead hand two
    // data pixels the same key, and a key-modifying combine cannot survive
    // that: the second write destroys the bits the first stashed.
    return [px, py > 0 ? py - 1 : Math.min(py + 1, IH - 1)];
  }

  const KEYMAP = {
    // one pixel left on even rows, one right on odd rows, reflected back
    // inside the interior at the edges
    adjacent: (dx, dy, W, H) => snapToKey(dx, dy, W, H),
    // diagonally opposite corner (180° rotation), then nearest key pixel
    poles: (dx, dy, W, H) => snapToKey(W - 1 - dx, H - 1 - dy, W, H),
    // horizontally flipped, then nearest key pixel
    "mirror-x": (dx, dy, W, H) => snapToKey(W - 1 - dx, dy, W, H),
    // vertically flipped, then nearest key pixel
    "mirror-y": (dx, dy, W, H) => snapToKey(dx, H - 1 - dy, W, H),
    // offset: key = data position + (kx, ky) wrapped torus-style, snapped to a
    // key pixel. (0,0) degenerates to the data pixel's own neighbour; large
    // offsets give double exposure.
    offset: (dx, dy, W, H, p = {}) => {
      const ox = (((dx + (p.kx | 0)) % W) + W) % W;
      const oy = (((dy + (p.ky | 0)) % H) + H) % H;
      return snapToKey(ox, oy, W, H);
    },
    // rotate: 90° clockwise pairing normalized to the interior aspect.
    rotate: (dx, dy, W, H) => {
      const px = Math.round((1 - (H > 1 ? dy / (H - 1) : 0)) * (W - 1));
      const py = Math.round((W > 1 ? dx / (W - 1) : 0) * (H - 1));
      return snapToKey(px, py, W, H);
    },
  };

  // ---- combine ops ------------------------------------------
  const COMBINE_NAMES = [
    "xor",
    "additive",
    "subtractive",
    "midpoint",
    "difference",
    "bitshift",
    "noise",
    "echo",
    "signed",
    "veil",
    "whisper",
  ];
  const COMBINE = {
    xor: (e, k) => e ^ k,
    additive: (e, k) => (e - k) & 0xff,
    subtractive: (e, k) => (k - e + 256) & 0xff,
    midpoint: (e, k) => (e * 2 - k) & 0xff,
    // key pixel stores the circular midpoint+floor(a/2); data = key - audio (mod 256)
    difference: (e, k) => (k - e + 256) & 0xff,
    // key is unchanged; low 3 bits of key determined the rotation — rotate data right to recover
    bitshift: (e, k) => {
      const s = k & 7;
      return ((e >>> s) | (e << (8 - s))) & 0xff;
    },
    // both pixels moved to flank audio value; midpoint of final pair = audio
    noise: (e, k) => Math.round(Math.abs(e - k) / 2 + Math.min(e, k)),
    // data pixel = audio; key pixel = origKey ^ audio (reversible XOR ghost).
    // audio is the data pixel; origKey recovers as key ^ data (see reconstruct).
    echo: (e, k) => e,
    // silence (128) leaves the pixel untouched; amplitude displaces ± proportionally
    signed: (e, k) => (e - k + 128) & 0xff,
    // blend is 25% audio / 75% key; key stashes audio's low 2 bits
    veil: (e, k) => (4 * e - 3 * k) & 0xff,
    // audio high nibble in data pixel low nibble; high nibbles of both pixels untouched
    whisper: (e, k) => ((e & 0x0f) << 4) | (k & 0x0f),
  };
  const ENCODE_OP = {
    xor: (a, k) => a ^ k,
    additive: (a, k) => (a + k) & 0xff,
    subtractive: (a, k) => (k - a + 256) & 0xff,
    midpoint: (a, k) => (a + k) >> 1,
    // mk = modified key (from KEY_MOD.difference); data = mk - audio (mod 256)
    difference: (a, mk) => (mk - a + 256) & 0xff,
    // rotate audio left by (key & 7); key pixel untouched so shift is recoverable on decode
    bitshift: (a, k) => {
      const s = k & 7;
      return ((a << s) | (a >>> (8 - s))) & 0xff;
    },
    // mk = audio + floor(usedSpace/2); data mirrors same distance below audio
    noise: (a, mk) => (2 * a - mk + 256) & 0xff,
    // data pixel carries the audio verbatim (key is set to origKey^audio by KEY_MOD)
    echo: (a, mk) => a,
    // mk = k; data shifts by (audio − 128) so silence (128) is invisible
    signed: (a, k) => (a + k + 128) & 0xff,
    // key stashes low 2 bits; blend is 25% audio, 75% key
    veil: (a, mk) => (a + 3 * mk) >> 2,
    // audio high nibble → data low nibble; keep data high nibble from original data pixel
    whisper: (a, mk, e) => (e & 0xf0) | (a >> 4),
  };
  // KEY_MOD(audio_byte, original_key_channel, original_data_channel) → new key channel value
  const KEY_MOD = {
    midpoint: (a, k) => (k & 0xfe) | (a & 1),
    // echo: key becomes the original key XOR the audio byte — a high-contrast,
    // perfectly reversible ghost (origKey = newKey ^ audio). XOR flips high bits
    // on loud samples for extreme swings; striking with poles/mirror keymaps.
    echo: (a, k) => k ^ a,
    // Spread the two pixels symmetrically around their midpoint by `a` steps.
    // Matches OLD: add 256 to key when key < data (byteSource < byteEncode in OLD's terms).
    difference: (a, k, e) => {
      let ks = k;
      if (ks < e) ks += 256;
      const mid = Math.round((ks - e) / 2 + e);
      return (mid + (a >> 1)) % 256;
    },
    // Use existing pixel contrast as carrier amplitude; key moves to audio + half of usable space.
    // usedSpace = min(|data-key|, 2*min(audio, 255-audio))
    noise: (a, k, e) => {
      const space = Math.abs(e - k);
      const usedSpace = Math.min(space, 2 * Math.min(a, 255 - a));
      return (a + Math.floor(usedSpace * 0.5)) % 256;
    },
    // key stashes audio's low 2 bits; blend is 25% audio (quarter-strength ghost)
    veil: (a, k) => (k & 0xfc) | (a & 3),
    // key stashes audio's low nibble; data keeps its high nibble (max delta 15)
    whisper: (a, k) => (k & 0xf0) | (a & 0x0f),
  };

  // ---- channel plan -----------------------------------------
  // A channel plan paints the byte stream onto a data pixel's RGB channels.
  //   plan.slots = [{ ch: 0|1|2, combine: <name> }, ...]   (ch 0=R 1=G 2=B)
  // Slots are consumed in order; each pulls one stream byte. Channels not named
  // by any slot pass through the source image untouched. bytesPerPixel === slots.length.
  // Two packing modes derive a plan but share one read/write primitive:
  //   packed  — active channels are an ordered subset of [r,g,b] (default all 3,
  //             order r,g,b); the stream flows continuously. Densest.
  //   aligned — channel count auto-set to min(bytesPerSample,3) so one sample lands
  //             in one pixel; the payload is padded to a pixel boundary so the
  //             byte-within-sample → channel mapping is identical for every pixel.
  const CHANNEL_NAMES = ["r", "g", "b"];
  const PACK_NAMES = ["packed", "aligned", "mono"];
  const CH = { r: 0, g: 1, b: 2 };

  // Compact descriptor token, order significant: "r.additive+g.xor+b.subtractive"
  // (an omitted channel is inactive / passthrough).
  function serializeChannelPlan(slots) {
    return slots.map((s) => `${CHANNEL_NAMES[s.ch]}.${s.combine}`).join("+");
  }
  function parseChannelPlan(token) {
    return String(token)
      .split("+")
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        const [c, comb] = t.split(".");
        return { ch: CH[c], combine: comb || "xor" };
      })
      .filter((s) => s.ch === 0 || s.ch === 1 || s.ch === 2);
  }

  // Accept explicit `channels` as: compact token ("r.additive+g.xor"), plain
  // letters ("rgb"/"bgr"), or an array of { ch|channel, combine } / letter strings.
  function _slotsFromChannels(channels, fallbackCombine) {
    if (typeof channels === "string") {
      if (channels.includes(".") || channels.includes("+"))
        return parseChannelPlan(channels);
      return channels
        .toLowerCase()
        .split("")
        .filter((c) => c in CH)
        .map((c) => ({ ch: CH[c], combine: fallbackCombine }));
    }
    return (channels || [])
      .map((s) => {
        if (typeof s === "string")
          return { ch: CH[s.toLowerCase()], combine: fallbackCombine };
        const key = s.ch ?? s.channel;
        const ch = typeof key === "number" ? key : CH[String(key).toLowerCase()];
        return { ch, combine: s.combine || fallbackCombine };
      })
      .filter((s) => s.ch === 0 || s.ch === 1 || s.ch === 2);
  }

  // Resolve an encode-time plan from options.
  //   opts.channels — explicit ordered slots (overrides pack auto-selection)
  //   opts.pack     — "packed" (default) | "aligned"
  //   opts.combine  — fallback op when per-channel ops are absent
  // bytesPerSample drives aligned channel count; tableSize drives alignment pad.
  function normalizeChannelPlan(opts = {}, bytesPerSample = 3, tableSize = 0) {
    const combine = opts.combine || "xor";
    // mono: one stream byte broadcast to all three channels — pure-luminance ghost
    if (opts.pack === "mono") {
      const slots = CHANNEL_NAMES.map((c) => ({ ch: CH[c], combine }));
      return { slots, pad: 0, pack: "mono", bytesPerPixel: 1, broadcast: true };
    }
    const pack = opts.pack === "aligned" ? "aligned" : "packed";
    let slots;
    if (opts.channels) {
      slots = _slotsFromChannels(opts.channels, combine);
    } else if (pack === "aligned") {
      const n = Math.min(Math.max(1, bytesPerSample | 0), 3);
      slots = CHANNEL_NAMES.slice(0, n).map((c) => ({ ch: CH[c], combine }));
    } else {
      slots = CHANNEL_NAMES.map((c) => ({ ch: CH[c], combine }));
    }
    if (!slots.length) slots = [{ ch: 0, combine }];
    const bpp = slots.length;
    const pad = pack === "aligned" ? (bpp - (tableSize % bpp)) % bpp : 0;
    return { slots, pad, pack, bytesPerPixel: bpp };
  }

  // True when this plan is the legacy default (packed, r→g→b, one shared combine);
  // lets the header stay compact + byte-identical to pre-channel-plan output.
  function _isDefaultPlan(plan) {
    return (
      plan.pack === "packed" &&
      plan.slots.length === 3 &&
      plan.slots.every((s, i) => s.ch === i) &&
      plan.slots[0].combine === plan.slots[1].combine &&
      plan.slots[1].combine === plan.slots[2].combine
    );
  }

  // ---- traversals -------------------------------------------
  // Paths are returned as a Uint32Array of interior-local linear indices
  // (v = y*W + x), filtered to data pixels. This is 4 bytes/pixel versus the
  // ~50-90 bytes a V8 [x,y] tuple costs — decisive for large images (tens of
  // millions of data pixels, where tuple arrays alone reached multiple GB and
  // crashed the tab). Recover coordinates with: lx = v % W, ly = (v / W) | 0.
  // getPath() still returns [x,y] tuples for callers/tests that want them.
  const TRAVERSAL_NAMES = [
    "raster",
    "boustrophedon",
    "spiral",
    "angle",
    "fisher-yates",
    "center-out",
    "hilbert",
    "polar",
    "bayer",
  ];

  // Count pixels matching `filter`. O(1) for the universal isDataPixel case so
  // we can allocate the exact Uint32Array; falls back to a scan for custom ones.
  function _countFiltered(W, H, filter) {
    if (filter === isDataPixel) return dataPixelCount(W, H);
    let n = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (filter(x, y)) n++;
    return n;
  }

  function rasterPath(W, H, filter = isDataPixel) {
    const out = new Uint32Array(_countFiltered(W, H, filter));
    let n = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (filter(x, y)) out[n++] = y * W + x;
    return out;
  }
  function boustrophedonPath(W, H, filter = isDataPixel) {
    const out = new Uint32Array(_countFiltered(W, H, filter));
    let n = 0;
    for (let y = 0; y < H; y++) {
      if (y % 2 === 0) {
        for (let x = 0; x < W; x++) if (filter(x, y)) out[n++] = y * W + x;
      } else {
        for (let x = W - 1; x >= 0; x--) if (filter(x, y)) out[n++] = y * W + x;
      }
    }
    return out;
  }
  function spiralPath(W, H, filter = isDataPixel) {
    const seen = new Uint8Array(W * H); // flat — one buffer, not H sub-arrays
    const out = new Uint32Array(_countFiltered(W, H, filter));
    let n = 0;
    const ddx = [1, 0, -1, 0],
      ddy = [0, 1, 0, -1];
    let x = 0,
      y = 0,
      dir = 0;
    for (let i = 0; i < W * H; i++) {
      if (filter(x, y)) out[n++] = y * W + x;
      seen[y * W + x] = 1;
      let nx = x + ddx[dir],
        ny = y + ddy[dir];
      if (nx < 0 || nx >= W || ny < 0 || ny >= H || seen[ny * W + nx]) {
        dir = (dir + 1) % 4;
        nx = x + ddx[dir];
        ny = y + ddy[dir];
      }
      x = nx;
      y = ny;
    }
    return out;
  }
  // angle: sort data pixels by a·x + b·y; (1,1)=diagonal-l, (-1,1)=diagonal-r, (1,0)=columns, etc.
  // tie-break by raster index (= the index value itself) so (0,0) degenerates to raster order
  function anglePath(W, H, filter = isDataPixel, a = 1, b = 1) {
    const idx = rasterPath(W, H, filter);
    const arr = Array.from(idx);
    arr.sort((p, q) => {
      const dk = a * (p % W) + b * ((p / W) | 0) - (a * (q % W) + b * ((q / W) | 0));
      return dk || p - q;
    });
    return Uint32Array.from(arr);
  }
  // fisher-yates: seeded LCG Fisher-Yates shuffle; seed stored in header per-encode
  function fisherYatesPath(W, H, filter = isDataPixel, seed) {
    const p = rasterPath(W, H, filter);
    let s = seed != null ? seed >>> 0 : (W * 1664525 + H * 1013904223) >>> 0;
    for (let i = p.length - 1; i > 0; i--) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const j = s % (i + 1);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    return p;
  }
  function centerOutPath(W, H, filter = isDataPixel) {
    const cx = (W - 1) / 2,
      cy = (H - 1) / 2;
    const arr = Array.from(rasterPath(W, H, filter));
    arr.sort((a, b) => {
      const ax = a % W,
        ay = (a / W) | 0,
        bx = b % W,
        by = (b / W) | 0;
      return (
        (ax - cx) ** 2 +
          (ay - cy) ** 2 -
          ((bx - cx) ** 2 + (by - cy) ** 2) || a - b
      );
    });
    return Uint32Array.from(arr);
  }
  function hilbertPath(W, H, filter = isDataPixel) {
    const size = 1 << Math.ceil(Math.log2(Math.max(W, H, 2)));
    const out = new Uint32Array(_countFiltered(W, H, filter));
    let n = 0;
    for (let t = 0; t < size * size; t++) {
      let x = 0,
        y = 0,
        s = 1,
        tt = t;
      for (s = 1; s < size; s <<= 1) {
        const rx = (tt >> 1) & 1,
          ry = (tt ^ rx) & 1;
        if (ry === 0) {
          if (rx === 1) {
            x = s - 1 - x;
            y = s - 1 - y;
          }
          const tmp = x;
          x = y;
          y = tmp;
        }
        x += s * rx;
        y += s * ry;
        tt >>= 2;
      }
      if (x < W && y < H && filter(x, y)) out[n++] = y * W + x;
    }
    return out;
  }
  // polar: clockwise angular sweep from 12 o'clock, radius ascending within a ray.
  // Integer-only comparator (no trig) so Node and every browser sort identically.
  function polarPath(W, H, filter = isDataPixel) {
    const arr = Array.from(rasterPath(W, H, filter));
    // doubled coords centered on the image: rx = 2x-(W-1), ry = 2y-(H-1)
    const RX = (v) => 2 * (v % W) - (W - 1);
    const RY = (v) => 2 * ((v / W) | 0) - (H - 1);
    // half 0 = [12:00, 6:00) i.e. right half-plane; half 1 = [6:00, 12:00)
    const half = (rx, ry) => (rx > 0 || (rx === 0 && ry <= 0) ? 0 : 1);
    arr.sort((p, q) => {
      const ax = RX(p), ay = RY(p), bx = RX(q), by = RY(q);
      const ha = half(ax, ay), hb = half(bx, by);
      if (ha !== hb) return ha - hb;
      const cross = ax * by - ay * bx;
      if (cross !== 0) return cross > 0 ? -1 : 1;
      return ax * ax + ay * ay - (bx * bx + by * by) || p - q;
    });
    return Uint32Array.from(arr);
  }
  // bayer: visit pixels in ordered-dither (Bayer matrix) order — every prefix of
  // the path is a uniform sample of the plane, so the reveal "develops" evenly.
  function bayerPath(W, H, filter = isDataPixel) {
    const bits = Math.max(1, Math.ceil(Math.log2(Math.max(W, H, 2))));
    const arr = Array.from(rasterPath(W, H, filter));
    const bv = (x, y) => {
      let v = 0;
      for (let i = 0; i < bits; i++) {
        const xb = (x >> i) & 1, yb = (y >> i) & 1;
        v = v * 4 + (((xb ^ yb) << 1) | yb);
      }
      return v;
    };
    arr.sort((p, q) => bv(p % W, (p / W) | 0) - bv(q % W, (q / W) | 0) || p - q);
    return Uint32Array.from(arr);
  }

  const TRAVERSALS = {
    raster: rasterPath,
    boustrophedon: boustrophedonPath,
    spiral: spiralPath,
    angle: anglePath,
    "fisher-yates": fisherYatesPath,
    "center-out": centerOutPath,
    hilbert: hilbertPath,
    polar: polarPath,
    bayer: bayerPath,
  };

  // Primitive: Uint32Array of interior-local linear indices (memory-efficient).
  function getPathIndices(W, H, traversal, params = {}) {
    if (traversal === "angle")
      return anglePath(W, H, isDataPixel, params.a ?? 1, params.b ?? 1);
    if (traversal === "fisher-yates")
      return fisherYatesPath(W, H, isDataPixel, params.seed);
    return (TRAVERSALS[traversal] || TRAVERSALS.raster)(W, H);
  }

  // Compatibility view: expand the index path to [x,y] tuples. Allocates ~16×
  // the memory of the index array, so only use it for small images / tests —
  // the encode/decode hot loops consume getPathIndices directly.
  function getPath(W, H, traversal, params = {}) {
    const idx = getPathIndices(W, H, traversal, params);
    const out = new Array(idx.length);
    for (let i = 0; i < idx.length; i++) out[i] = [idx[i] % W, (idx[i] / W) | 0];
    return out;
  }

  // ---- image scaling ----------------------------------------
  function scaleImg(img, newW, newH) {
    const out = new Img(newW, newH, new Uint8Array(newW * newH * 4));
    const sx = img.width / newW,
      sy = img.height / newH;
    for (let y = 0; y < newH; y++) {
      for (let x = 0; x < newW; x++) {
        const qx = x * sx,
          qy = y * sy;
        const x0 = Math.floor(qx),
          x1 = Math.min(img.width - 1, x0 + 1);
        const y0 = Math.floor(qy),
          y1 = Math.min(img.height - 1, y0 + 1);
        const fx = qx - x0,
          fy = qy - y0;
        const w00 = (1 - fx) * (1 - fy),
          w10 = fx * (1 - fy),
          w01 = (1 - fx) * fy,
          w11 = fx * fy;
        const [r00, g00, b00] = img.get(x0, y0),
          [r10, g10, b10] = img.get(x1, y0);
        const [r01, g01, b01] = img.get(x0, y1),
          [r11, g11, b11] = img.get(x1, y1);
        out.set(
          x,
          y,
          Math.round(r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11),
          Math.round(g00 * w00 + g10 * w10 + g01 * w01 + g11 * w11),
          Math.round(b00 * w00 + b10 * w10 + b01 * w01 + b11 * w11),
        );
      }
    }
    return out;
  }

  function cropImg(img, sx, sy, sw, sh) {
    const out = new Img(sw, sh, new Uint8Array(sw * sh * 4));
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const [r, g, b] = img.get(sx + x, sy + y);
        out.set(x, y, r, g, b);
      }
    return out;
  }

  // Interior dimensions holding `dataPx` data pixels, sized so the FULL canvas
  // (interior + B px of border on every side) has `aspect`. The cover is scaled
  // to the full canvas, so matching the FULL aspect — not the interior aspect —
  // is what keeps a large border from stretching it. B=0 → plain aspect-fit.
  function interiorDims(dataPx, aspect, B = 0) {
    // Solve aspect·h² − 2B(aspect+1)·h + (4B² − 2·dataPx) = 0 for the full height
    // h = IH+2B (interior area ≈ 2·dataPx at the full aspect), then round + top up.
    const qb = -2 * B * (aspect + 1);
    const qc = 4 * B * B - 2 * dataPx;
    const disc = Math.max(0, qb * qb - 4 * aspect * qc);
    const h = (-qb + Math.sqrt(disc)) / (2 * aspect);
    let IH = Math.max(2, Math.round(h - 2 * B));
    let IW = Math.max(2, Math.round(aspect * (IH + 2 * B) - 2 * B));
    while (dataPixelCount(IW, IH) < dataPx) {
      // grow whichever side keeps the full-canvas aspect closest to target
      const dW = Math.abs((IW + 1 + 2 * B) / (IH + 2 * B) - aspect);
      const dH = Math.abs((IW + 2 * B) / (IH + 1 + 2 * B) - aspect);
      if (dW <= dH) IW++;
      else IH++;
    }
    return { IW, IH };
  }

  // Resolve a border spec to an integer borderWidth (px per side, including the
  // mandatory 1px header ring).
  //   spec >= 1   → explicit "extra" px beyond the minimum: 1 + floor(spec)
  //                 (the legacy integer meaning; backward compatible).
  //   0 < spec < 1 → a FRACTION of the final image WIDTH. The interior is sized
  //                 for full-canvas aspect (interiorDims with this B), so the
  //                 final width satisfies fullW²·(1−2f)(1/aspect−2f) ≈ 2·dataPx;
  //                 border = f·fullW. A series sharing an aspect ratio then gets
  //                 a consistent border at any payload-driven size, with no
  //                 aspect drift. Capped so both factors stay positive.
  function resolveBorderWidth(spec, dataPx, aspect) {
    const f = Number(spec) || 0;
    if (f > 0 && f < 1) {
      const ff = Math.min(f, 0.45, 0.45 / aspect);
      const fullW = Math.sqrt(
        (2 * dataPx) / ((1 - 2 * ff) * (1 / aspect - 2 * ff)),
      );
      return Math.max(1, Math.round(ff * fullW));
    }
    return 1 + Math.max(0, Math.floor(f));
  }

  // Border-row pixels the STGC header will occupy — the minimum WIDTH any
  // encoded canvas can have. Header length is 12 + descriptor + 1 checksum, and
  // the descriptor depends only on the effect settings, so this is knowable
  // before the canvas is sized. Each byte rides TWO border pixels as nibbles,
  // hence the doubling, plus the B bootstrap and even-offset alignment.
  // Deliberately a slight over-estimate (widest seed, slack): it's used as a
  // floor, and a canvas a few pixels wider than strictly needed costs nothing.
  function stgcHeaderWidth(opts = {}) {
    const plan =
      opts.plan || normalizeChannelPlan(opts, opts.bytesPerSample ?? 3, 0);
    const params = { ...(opts.params || {}) };
    if ((opts.traversal || "raster") === "fisher-yates" && params.seed == null)
      params.seed = 0xffffffff;
    return (
      packStgcHeader({
        combine: opts.combine || "xor",
        keyMap: opts.keyMap || "adjacent",
        traversal: opts.traversal || "raster",
        interiorByteLength: 0,
        entryCount: 0,
        params,
        ch:
          _isDefaultPlan(plan) || plan.broadcast
            ? undefined
            : serializeChannelPlan(plan.slots),
        pad: plan.pad,
        pack: plan.pack,
      }).length *
        2 +
      8
    );
  }

  function autoScaleImg(
    img,
    totalBytes,
    B = 1,
    aspectOverride = null,
    bytesPerPixel = 3,
    minWidth = 0,
  ) {
    const dataPx = Math.ceil(totalBytes / bytesPerPixel);
    const aspect =
      aspectOverride != null ? aspectOverride : img.width / img.height;

    // size the interior so the FULL canvas (interior + border) is at `aspect` —
    // otherwise a large border drifts the canvas aspect and stretches the cover.
    let { IW, IH } = interiorDims(dataPx, aspect, B);

    // a tiny payload (a text-only data cartridge) can size the canvas below the
    // header's width — widen to the floor, keep the aspect, keep the capacity
    if (minWidth && IW + 2 * B < minWidth) {
      IW = Math.max(2, minWidth - 2 * B);
      IH = Math.max(2, Math.round((IW + 2 * B) / aspect) - 2 * B);
      while (dataPixelCount(IW, IH) < dataPx) IH++;
    }

    // Dimensions are left exactly as the payload and aspect ask for. Nudging
    // the width to dodge the odd-width orphan (see snapToKey) would take a
    // square interior off-square, and the `rotate` keymap is only injective
    // while it is square — that corrupted a real cartridge. The orphan is
    // handled in the keymap instead.

    // total canvas = interior + border on every side
    const newW = IW + 2 * B,
      newH = IH + 2 * B;

    // shortcut: source is already the right total size with no AR change
    if (aspectOverride == null && newW === img.width && newH === img.height)
      return img;

    // cover-crop source to target aspect ratio (centered)
    let src = img;
    const srcAspect = img.width / img.height;
    if (Math.abs(srcAspect - aspect) > 0.0005) {
      let cropW, cropH;
      if (srcAspect > aspect) {
        cropH = img.height;
        cropW = Math.max(1, Math.round(img.height * aspect));
      } else {
        cropW = img.width;
        cropH = Math.max(1, Math.round(img.width / aspect));
      }
      const sx = Math.floor((img.width - cropW) / 2);
      const sy = Math.floor((img.height - cropH) / 2);
      src = cropImg(img, sx, sy, cropW, cropH);
    }

    // scale cover-cropped source to full canvas; encodeContainer overwrites
    // only the ~9 header pixels in the border, rest carries image content
    return scaleImg(src, newW, newH);
  }

  // ════════════════════════════════════════════════════════════
  // STGC CONTAINER FORMAT
  // ════════════════════════════════════════════════════════════

  const STGC_MAGIC = [0x53, 0x54, 0x47, 0x43]; // "STGC"
  const STGC_VERSION = 1;

  // Descriptor: \x01-separated "key=value\x01" pairs (no null bytes; safe for alpha channel).
  // `ch` (channel-plan token), `pad`, `pack` are emitted only for non-default
  // plans so legacy/default output stays compact and byte-identical.
  function buildDescriptor({ combine, keyMap, traversal, params = {}, ch, pad, pack }) {
    let s = `combine=${combine || "xor"}\x01keymap=${keyMap || "adjacent"}\x01traversal=${traversal || "raster"}\x01`;
    if (traversal === "fisher-yates")
      s += `seed=${(params.seed ?? 0) >>> 0}\x01`;
    if (traversal === "angle")
      s += `a=${params.a ?? 1}\x01b=${params.b ?? 1}\x01`;
    if (keyMap === "offset")
      s += `kx=${params.kx | 0}\x01ky=${params.ky | 0}\x01`;
    if (ch) s += `ch=${ch}\x01`;
    if (pad) s += `pad=${pad >>> 0}\x01`;
    if (pack && pack !== "packed") s += `pack=${pack}\x01`;
    return new TextEncoder().encode(s);
  }

  function parseDescriptor(bytes) {
    const out = {};
    for (const chunk of new TextDecoder().decode(bytes).split("\x01")) {
      const eq = chunk.indexOf("=");
      if (eq > 0) out[chunk.slice(0, eq)] = chunk.slice(eq + 1);
    }
    if (out.seed != null) out.seed = parseInt(out.seed, 10) >>> 0;
    if (out.a != null) out.a = parseInt(out.a, 10);
    if (out.b != null) out.b = parseInt(out.b, 10);
    if (out.kx != null) out.kx = parseInt(out.kx, 10) | 0;
    if (out.ky != null) out.ky = parseInt(out.ky, 10) | 0;
    if (out.pad != null) out.pad = parseInt(out.pad, 10) >>> 0;
    return out;
  }

  // Fixed block: 12 bytes — magic, version, interiorByteLength, entryCount, descLen, reserved
  // Descriptor block: descLen bytes immediately after
  // Checksum byte: XOR of all preceding bytes, appended at end
  // Total header = 12 + descLen + 1 bytes, stored in alpha channel of border pixels.
  function packStgcHeader({
    combine,
    keyMap,
    traversal,
    interiorByteLength,
    entryCount,
    params = {},
    ch,
    pad,
    pack,
  }) {
    const desc = buildDescriptor({ combine, keyMap, traversal, params, ch, pad, pack });
    const b = new Uint8Array(12 + desc.length + 1); // +1 for XOR checksum
    STGC_MAGIC.forEach((c, i) => (b[i] = c));
    b[4] = STGC_VERSION;
    const ibl = interiorByteLength >>> 0;
    b[5] = ibl & 0xff;
    b[6] = (ibl >>> 8) & 0xff;
    b[7] = (ibl >>> 16) & 0xff;
    b[8] = (ibl >>> 24) & 0xff;
    b[9] = entryCount & 0xff;
    b[10] = desc.length & 0xff;
    b[11] = 0; // descLen always < 256; byte 11 reserved
    b.set(desc, 12);
    let xor = 0;
    for (let i = 0; i < b.length - 1; i++) xor ^= b[i];
    b[b.length - 1] = xor;
    return b;
  }

  // Recover zero bytes clamped to 1 during encode, using XOR checksum.
  // Also tries treating the checksum byte itself as 0 if it was stored as 1.
  function _recoverZeros(hdr) {
    const n = hdr.length;
    const ones = [];
    for (let i = 0; i < n - 1; i++) if (hdr[i] === 1) ones.push(i);
    const m = Math.min(ones.length, 20);
    // outer loop: try checksum byte as stored, then as 0 if it was clamped (stored as 1)
    for (const chk of [hdr[n - 1], ...(hdr[n - 1] === 1 ? [0] : [])]) {
      for (let mask = 0; mask < 1 << m; mask++) {
        const cand = new Uint8Array(hdr);
        cand[n - 1] = chk;
        for (let j = 0; j < m; j++) if (mask & (1 << j)) cand[ones[j]] = 0;
        let xor = 0;
        for (let i = 0; i < n - 1; i++) xor ^= cand[i];
        if (xor === cand[n - 1]) return cand;
      }
    }
    throw new Error("STGC header checksum mismatch");
  }

  // Header bytes ride the border alpha as high/low nibble pairs, so every
  // header pixel keeps alpha >= 240 and the border renders as good as opaque.
  // A nibble n is stored as alpha 255 - n; an untouched border pixel (255)
  // reads back as nibble 0. Matches @amplib/steganography.
  function _nibbleByte(alphaHi, alphaLo) {
    return (((255 - alphaHi) & 0xf) << 4) | ((255 - alphaLo) & 0xf);
  }

  // Read the header from the border alpha. Current images store nibble pairs;
  // before that the format stored one raw byte per pixel — which rendered the
  // header as a nearly transparent strip — so all three layouts are tried in
  // turn: nibble pairs, then whole bytes inverted, then whole bytes raw.
  function unpackStgcHeaderAlpha(img) {
    try {
      return _unpackNibbles(img);
    } catch (_) {
      try {
        return _unpackWholeBytes(img, (a) => 255 - a);
      } catch (__) {
        return _unpackWholeBytes(img, (a) => a);
      }
    }
  }

  function _unpackNibbles(img) {
    // bootstrap B from the ring start — raster order makes the first pixels
    // identical for every border width
    const tmpBpx = getBorderPixels(img.width, img.height, 1);
    if (tmpBpx.length < 6) throw new Error("not a STGC image");
    const alphaAt = (i) => img.getAlpha(tmpBpx[i][0], tmpBpx[i][1]);
    let B = _nibbleByte(alphaAt(0), alphaAt(1));
    if (B === 0) {
      B =
        _nibbleByte(alphaAt(2), alphaAt(3)) |
        (_nibbleByte(alphaAt(4), alphaAt(5)) << 8);
      if (B === 0) throw new Error("not a STGC image");
    }
    const bpx = getBorderPixels(img.width, img.height, B);
    const bytes = new Uint8Array(bpx.length >> 1);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = _nibbleByte(
        img.getAlpha(bpx[i * 2][0], bpx[i * 2][1]),
        img.getAlpha(bpx[i * 2 + 1][0], bpx[i * 2 + 1][1]),
      );
    return _parseRingBytes(bytes, B);
  }

  function _unpackWholeBytes(img, read) {
    let B = read(img.getAlpha(0, 0));
    if (B === 0) {
      // 2-byte B: enumerate with B=1 to find fixed pixel positions
      const tmpBpx = getBorderPixels(img.width, img.height, 1);
      if (tmpBpx.length < 3) throw new Error("not a STGC image");
      B =
        read(img.getAlpha(tmpBpx[1][0], tmpBpx[1][1])) |
        (read(img.getAlpha(tmpBpx[2][0], tmpBpx[2][1])) << 8);
      if (B === 0) throw new Error("not a STGC image");
    }
    const bpx = getBorderPixels(img.width, img.height, B);
    const alphas = new Uint8Array(bpx.length);
    for (let i = 0; i < bpx.length; i++)
      alphas[i] = read(img.getAlpha(bpx[i][0], bpx[i][1]));
    return _parseRingBytes(alphas, B);
  }

  // Locate the magic in the ring byte sequence and unpack the fields.
  function _parseRingBytes(alphas, B) {
    let magicOff = -1;
    for (let i = 0; i <= alphas.length - 4; i++) {
      if (
        alphas[i] === 0x53 &&
        alphas[i + 1] === 0x54 &&
        alphas[i + 2] === 0x47 &&
        alphas[i + 3] === 0x43
      ) {
        magicOff = i;
        break;
      }
    }
    if (magicOff === -1) throw new Error("not a STGC image");
    if (alphas[magicOff + 4] !== STGC_VERSION)
      throw new Error(`unsupported STGC version: ${alphas[magicOff + 4]}`);

    const descLen = alphas[magicOff + 10];
    const hdrLen = 12 + descLen + 1;
    if (magicOff + hdrLen > alphas.length)
      throw new Error("STGC header extends beyond border");

    const hdr = alphas.slice(magicOff, magicOff + hdrLen);
    const recovered = _recoverZeros(hdr);
    const ibl =
      (recovered[5] |
        (recovered[6] << 8) |
        (recovered[7] << 16) |
        (recovered[8] << 24)) >>>
      0;
    const entryCount = recovered[9];
    const d = parseDescriptor(recovered.slice(12, 12 + descLen));

    return {
      B,
      version: recovered[4],
      combine: d.combine || "xor",
      keyMap: d.keymap || "adjacent",
      traversal: d.traversal || "raster",
      ch: d.ch || null,
      pad: d.pad || 0,
      pack: d.pack || "packed",
      interiorByteLength: ibl,
      entryCount,
      params: d,
    };
  }

  // ---- audio mimetype helpers (RFC 2586) --------------------
  // Audio payloads are raw PCM; the mimetype carries the format metadata.
  function buildAudioMime({ bits, rate, channels, layout, blockSize }) {
    let s = `audio/L${bits}; rate=${rate}; channels=${channels}`;
    if (layout && layout !== "planar") s += `; layout=${layout}`;
    if (layout === "block" && blockSize) s += `; block=${blockSize}`;
    return s;
  }
  function parseAudioMime(s) {
    const bits = parseInt((s.match(/audio\/L(\d+)/i) || [])[1] || "16");
    const rate = parseInt((s.match(/rate=(\d+)/i) || [])[1] || "44100");
    const channels = parseInt((s.match(/channels=(\d+)/i) || [])[1] || "1");
    const layout = (s.match(/layout=([\w-]+)/i) || [])[1] || "planar";
    const blockSize = parseInt((s.match(/block=(\d+)/i) || [])[1]) || 0;
    return { bits, rate, channels, layout, blockSize };
  }

  // ---- channel layout helpers --------------------------------
  // layoutChannels: permute per-channel planar samples into stream order.
  // mixed: Array<Float32Array>, one per channel. Returns a single Float32Array.
  function layoutChannels({ mixed, layout, blockSize }) {
    const M = mixed.length,
      N = mixed[0].length;
    const out = new Float32Array(N * M);
    if (M === 1 || !layout || layout === "planar") {
      for (let c = 0; c < M; c++) out.set(mixed[c], c * N);
      return out;
    }
    const K = layout === "interleaved" ? 1 : blockSize || 1;
    for (let c = 0; c < M; c++)
      for (let s = 0; s < N; s++)
        out[Math.floor(s / K) * K * M + c * K + (s % K)] = mixed[c][s];
    return out;
  }

  // unlayoutChannels: inverse of layoutChannels. Returns Float32Array in planar order
  // (ch0 run then ch1 run …) ready for AudioBuffer.getChannelData fills.
  function unlayoutChannels({ f32, layout, channels, blockSize }) {
    const M = channels,
      N = (f32.length / M) | 0;
    if (M === 1 || !layout || layout === "planar") return f32;
    const K = layout === "interleaved" ? 1 : blockSize || 1;
    const out = new Float32Array(N * M);
    for (let c = 0; c < M; c++)
      for (let s = 0; s < N; s++)
        out[c * N + s] = f32[Math.floor(s / K) * K * M + c * K + (s % K)];
    return out;
  }

  // computeRevealOrder: returns an Int32Array of length pathLen where
  // revealOrder[i] is the path-relative index (0..pathLen-1) of the pixel
  // that carries the i-th "audio frame" (all channels simultaneously).
  // pathStart: first index in the global path that belongs to this audio entry.
  // pathLen: number of data pixels used by this audio entry.
  // At 24-bit, 1 pixel = 1 sample. At other bit depths the pixel→sample
  // boundary is fractional; we snap each pixel to its last-touched sample frame.
  // bytesPerPixel: bytes the channel plan writes per data pixel (was fixed 3).
  function computeRevealOrder({
    pathLen,
    channels,
    bits,
    layout,
    blockSize,
    bytesPerPixel = 3,
  }) {
    const M = channels;
    const B = bits >> 3; // bytes per sample
    const BPP = bytesPerPixel || 3;
    const N = Math.floor((pathLen * BPP) / B / M); // samples per channel

    // pixelRevealFrame[px] = earliest audio frame index i such that
    // some byte of frame i falls within pixel px's byte range [BPP*px, BPP*px+BPP-1].
    // Pixels never touched by any frame keep the sentinel value N (sort last).
    const pixelRevealFrame = new Int32Array(pathLen).fill(N);

    function markRange(i, byteStart, byteEnd) {
      const px0 = Math.floor(byteStart / BPP);
      const px1 = Math.min(Math.floor(byteEnd / BPP), pathLen - 1);
      for (let px = px0; px <= px1; px++) {
        if (i < pixelRevealFrame[px]) pixelRevealFrame[px] = i;
      }
    }

    if (M === 1 || !layout || layout === "planar") {
      if (M === 1 && BPP === B)
        return Int32Array.from({ length: pathLen }, (_, i) => i);
      for (let i = 0; i < N; i++) {
        for (let c = 0; c < M; c++) {
          const byteStart = (c * N + i) * B;
          markRange(i, byteStart, byteStart + B - 1);
        }
      }
    } else {
      const K = layout === "interleaved" ? 1 : blockSize || 1;
      for (let i = 0; i < N; i++) {
        for (let c = 0; c < M; c++) {
          const streamPos = Math.floor(i / K) * K * M + c * K + (i % K);
          const byteStart = streamPos * B;
          markRange(i, byteStart, byteStart + B - 1);
        }
      }
    }

    const sorted = Array.from({ length: pathLen }, (_, i) => i);
    sorted.sort((a, b) => pixelRevealFrame[a] - pixelRevealFrame[b] || a - b);
    return new Int32Array(sorted);
  }

  // ---- reconstruction ---------------------------------------
  // These ops leave the key (non-data) pixel untouched, so the original cover
  // value survives exactly in it. difference / noise / echo move BOTH pixels
  // and can only be rebuilt per data+key pair.
  const KEY_PRESERVING = new Set([
    "xor",
    "additive",
    "subtractive",
    "bitshift",
    "midpoint",
    "signed",
    "veil",
    "whisper",
  ]);

  // computeRecon: rebuild a viewable cover image from an encoded container.
  // encImg is the decoded PNG, pathIdx the interior path from getPathIndices,
  // opts the decode opts from decodeContainer (plan/keyMap/params/borderWidth/
  // interiorByteLength). Returns { data: Uint8ClampedArray RGBA, width, height }
  // — half resolution when every active channel is key-preserving (or mixed),
  // full resolution only for pure difference/noise/echo plans.
  function computeRecon(encImg, pathIdx, opts) {
    const W = encImg.width,
      H = encImg.height;
    const px = encImg.data;
    const B = opts.borderWidth || 1;
    const IW = W - 2 * B,
      IH = H - 2 * B;
    const params = opts.params || {};
    const km = KEYMAP[opts.keyMap || "adjacent"];
    if (!km) throw new Error(`unknown keymap: ${opts.keyMap}`);
    const plan = _resolvePlan(opts);
    const bytesPerPixel = plan.bytesPerPixel || plan.slots.length;
    const dataXY = (pi) => {
      const v = pathIdx[pi];
      return [(v % IW) + B, ((v / IW) | 0) + B];
    };
    const keyXY = (pi) => {
      const v = pathIdx[pi];
      const lx = v % IW,
        ly = (v / IW) | 0;
      const [klx, kly] = km(lx, ly, IW, IH, params);
      return [klx + B, kly + B];
    };
    // per-channel combine from the plan; channels with no slot are
    // passthrough (carry no data → keep the encoded/source value).
    const chCombine = [null, null, null];
    for (const s of plan.slots) chCombine[s.ch] = s.combine;
    const realOnly = chCombine.every(
      (c) => c == null || KEY_PRESERVING.has(c),
    );
    // mixed plan: at least one key-preserving channel alongside a
    // difference/noise/echo one. The full-res pass runs (below), then
    // we decimate it to half-res keeping only the real/restored key
    // pixels — so even mixed plans avoid fabricated data pixels.
    const hasKeyPreserving = chCombine.some(
      (c) => c != null && KEY_PRESERVING.has(c),
    );
    let reconData, reconW, reconH;
    if (realOnly) {
      // Real-only reconstruction: rather than fabricating each data
      // pixel from its 4 neighbours (the old path — a checkerboard
      // blur), drop them. Every 2×2 block keeps its two real key
      // pixels — the (even,even) and (odd,odd) diagonal corners, which
      // were never overwritten — averaged into one output pixel. Half
      // resolution, but made only of true cover pixels (no guessing).
      reconW = (W + 1) >> 1;
      reconH = (H + 1) >> 1;
      reconData = new Uint8ClampedArray(reconW * reconH * 4);
      for (let by = 0; by < reconH; by++) {
        for (let bx = 0; bx < reconW; bx++) {
          const x0 = bx << 1,
            y0 = by << 1;
          const tl = (y0 * W + x0) * 4;
          const x1 = x0 + 1,
            y1 = y0 + 1;
          const hasBR = x1 < W && y1 < H;
          const br = hasBR ? (y1 * W + x1) * 4 : tl;
          const o = (by * reconW + bx) * 4;
          for (let c = 0; c < 3; c++) {
            // some ops stash audio bits in key low bits; mask them out
            const KEY_MASK = { midpoint: 0xfe, veil: 0xfc, whisper: 0xf0 };
            const m = KEY_MASK[chCombine[c]] ?? 0xff;
            reconData[o + c] = hasBR
              ? ((px[tl + c] & m) + (px[br + c] & m) + 1) >> 1
              : px[tl + c] & m;
          }
          reconData[o + 3] = 255;
        }
      }
    } else {
      reconW = W;
      reconH = H;
      reconData = new Uint8ClampedArray(px);
      // encode stops once the data stream is exhausted, so only the
      // first nEnc data pixels were touched — the rest stay original.
      // Reconstructing past nEnc would corrupt those (esp. echo, where
      // key^data on an untouched pair = origKey^origData = noise).
      const nEnc = Math.min(
        pathIdx.length,
        Math.ceil((opts.interiorByteLength || 0) / bytesPerPixel),
      );
      for (let pi = 0; pi < nEnc; pi++) {
        const [dx, dy] = dataXY(pi);
        const eo = (dy * W + dx) * 4;
        for (let c = 0; c < 3; c++) {
          if (chCombine[c] == null) {
            reconData[eo + c] = px[eo + c]; // passthrough = source
            continue;
          }
          const m = chCombine[c] === "midpoint" ? 0xfe : 0xff;
          let acc = 0,
            n = 0;
          for (const [nx, ny] of [
            [dx - 1, dy],
            [dx + 1, dy],
            [dx, dy - 1],
            [dx, dy + 1],
          ]) {
            if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
              acc += px[(ny * W + nx) * 4 + c] & m;
              n++;
            }
          }
          reconData[eo + c] = n ? Math.round(acc / n) : 0;
        }
      }
      // restore key-pixel symmetry per channel for midpoint/difference/echo
      for (let i = 0; i < nEnc; i++) {
        const [dx, dy] = dataXY(i),
          [kx, ky] = keyXY(i);
        const doff = (dy * W + dx) * 4,
          koff = (ky * W + kx) * 4;
        for (let c = 0; c < 3; c++) {
          if (chCombine[c] === "midpoint") {
            reconData[koff + c] &= 0xfe;
          } else if (chCombine[c] === "difference") {
            let sp = px[koff + c],
              dp = px[doff + c];
            if (sp < dp) sp += 256;
            const mid = Math.round((sp - dp) / 2 + dp) & 0xff;
            reconData[doff + c] = mid;
            reconData[koff + c] = mid;
          } else if (chCombine[c] === "echo") {
            // origKey = newKey ^ audio, and audio = data pixel → key ^ data
            reconData[koff + c] = px[koff + c] ^ px[doff + c];
          }
        }
      }
      // echo: the first pass interpolated data pixels from the *encoded*
      // neighbors, but with echo those neighbors are noisy (origKey^audio).
      // Now that keys are restored exactly, re-interpolate from the clean
      // values. (Bounded to nEnc so the untouched tail stays original.)
      if (chCombine.some((c) => c === "echo")) {
        for (let pi = 0; pi < nEnc; pi++) {
          const [dx, dy] = dataXY(pi);
          const eo = (dy * W + dx) * 4;
          for (let c = 0; c < 3; c++) {
            if (chCombine[c] !== "echo") continue;
            let acc = 0,
              n = 0;
            for (const [nx, ny] of [
              [dx - 1, dy],
              [dx + 1, dy],
              [dx, dy - 1],
              [dx, dy + 1],
            ]) {
              if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
                acc += reconData[(ny * W + nx) * 4 + c];
                n++;
              }
            }
            if (n) reconData[eo + c] = Math.round(acc / n);
          }
        }
      }
      // Mixed plan: decimate the full-res recon to half-res, sampling
      // only the two key pixels per 2×2 block (the (even,even)+(odd,odd)
      // diagonal). Those hold real values for key-preserving channels
      // and restored values for difference/echo — never the fabricated
      // data pixels — so the result is all-real/restored at half res.
      if (hasKeyPreserving) {
        const rw = (W + 1) >> 1,
          rh = (H + 1) >> 1;
        const half = new Uint8ClampedArray(rw * rh * 4);
        for (let by = 0; by < rh; by++) {
          for (let bx = 0; bx < rw; bx++) {
            const x0 = bx << 1,
              y0 = by << 1;
            const tl = (y0 * W + x0) * 4;
            const x1 = x0 + 1,
              y1 = y0 + 1;
            const hasBR = x1 < W && y1 < H;
            const br = hasBR ? (y1 * W + x1) * 4 : tl;
            const o = (by * rw + bx) * 4;
            for (let c = 0; c < 3; c++)
              half[o + c] = hasBR
                ? (reconData[tl + c] + reconData[br + c] + 1) >> 1
                : reconData[tl + c];
            half[o + 3] = 255;
          }
        }
        reconData = half;
        reconW = rw;
        reconH = rh;
      }
    }
    return { data: reconData, width: reconW, height: reconH };
  }

  // ---- entry table helpers ----------------------------------
  function _u8(data) {
    if (!data) return new Uint8Array(0);
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (typeof data === "string") return new TextEncoder().encode(data);
    return new Uint8Array(data); // Buffer, Uint8ClampedArray, etc.
  }

  // Byte length of the entry table alone (records, no payloads).
  function _tableSize(entries) {
    const enc = new TextEncoder();
    let n = 0;
    for (const e of entries)
      n +=
        2 +
        enc.encode(e.mimetype || "application/octet-stream").length +
        2 +
        enc.encode(e.name || "").length +
        4;
    return n;
  }

  // Build the complete interior byte stream:
  // [entry table records] [pad×`pad` zero bytes] [payload 0] [payload 1] ...
  // `pad` aligns the first payload to a pixel boundary (aligned channel plans).
  function buildInteriorStream(entries, pad = 0) {
    const enc = new TextEncoder();
    const norm = entries.map((e) => ({
      mt: enc.encode(e.mimetype || "application/octet-stream"),
      nm: enc.encode(e.name || ""),
      data: _u8(e.data),
    }));

    let tableSize = 0;
    for (const r of norm) tableSize += 2 + r.mt.length + 2 + r.nm.length + 4;
    const totalPayload = norm.reduce((s, r) => s + r.data.length, 0);
    const stream = new Uint8Array(tableSize + pad + totalPayload);

    let off = 0;
    for (const r of norm) {
      stream[off++] = r.mt.length & 0xff;
      stream[off++] = (r.mt.length >> 8) & 0xff;
      stream.set(r.mt, off);
      off += r.mt.length;
      stream[off++] = r.nm.length & 0xff;
      stream[off++] = (r.nm.length >> 8) & 0xff;
      stream.set(r.nm, off);
      off += r.nm.length;
      const dl = r.data.length;
      stream[off++] = dl & 0xff;
      stream[off++] = (dl >> 8) & 0xff;
      stream[off++] = (dl >> 16) & 0xff;
      stream[off++] = (dl >> 24) & 0xff;
    }
    off += pad; // zero-filled gap between table and payloads
    for (const r of norm) {
      stream.set(r.data, off);
      off += r.data.length;
    }
    return stream;
  }

  // Parse entry table from the interior stream; returns array of
  // {mimetype, name, payloadLen, dataOffset} where dataOffset is absolute in stream.
  function parseEntryTable(stream, entryCount, pad = 0) {
    const dec = new TextDecoder();
    const meta = [];
    let off = 0;
    for (let i = 0; i < entryCount; i++) {
      const mtLen = stream[off] | (stream[off + 1] << 8);
      off += 2;
      const mimetype = dec.decode(stream.slice(off, off + mtLen));
      off += mtLen;
      const nmLen = stream[off] | (stream[off + 1] << 8);
      off += 2;
      const name = dec.decode(stream.slice(off, off + nmLen));
      off += nmLen;
      const payloadLen =
        (stream[off] |
          (stream[off + 1] << 8) |
          (stream[off + 2] << 16) |
          (stream[off + 3] << 24)) >>>
        0;
      off += 4;
      meta.push({ mimetype, name, payloadLen, dataOffset: 0 });
    }
    let payloadOff = off + pad; // skip the alignment gap before payloads
    for (const m of meta) {
      m.dataOffset = payloadOff;
      payloadOff += m.payloadLen;
    }
    return meta;
  }

  // ---- container capacity -----------------------------------
  function containerInteriorBytes(entries) {
    const enc = new TextEncoder();
    let total = 0;
    for (const e of entries) {
      total += 2 + enc.encode(e.mimetype || "application/octet-stream").length;
      total += 2 + enc.encode(e.name || "").length;
      total += 4;
      total += e.data ? _u8(e.data).length : 0;
    }
    return total;
  }

  // ---- interior read / write --------------------------------
  // opts.plan is a resolved channel plan ({ slots:[{ch,combine}], ... }).
  // Falls back to the legacy default (packed r,g,b + opts.combine) when absent.
  function _resolvePlan(opts) {
    return opts.plan || normalizeChannelPlan(opts);
  }

  function _writeInterior(img, keyImg, stream, opts) {
    const B = opts.borderWidth || 1;
    const IW = img.width - 2 * B,
      IH = img.height - 2 * B;
    const path = getPathIndices(
      IW,
      IH,
      opts.traversal || "raster",
      opts.params || {},
    );
    const plan = _resolvePlan(opts);
    const slots = plan.slots;
    const km = KEYMAP[opts.keyMap || "adjacent"];
    if (!km) throw new Error(`unknown keymap: ${opts.keyMap}`);
    const params = opts.params || {};
    let ai = 0;
    for (let pi = 0; pi < path.length; pi++) {
      if (ai >= stream.length) break;
      const v = path[pi];
      const lx = v % IW,
        ly = (v / IW) | 0;
      const dx = lx + B,
        dy = ly + B;
      const [klx, kly] = km(lx, ly, IW, IH, params);
      const kx = klx + B,
        ky = kly + B;
      const k = keyImg.get(kx, ky); // source key pixel
      const cur = img.get(dx, dy); // source data pixel (passthrough baseline)
      const outD = [cur[0], cur[1], cur[2]];
      const outK = [k[0], k[1], k[2]];
      let keyTouched = false;
      // broadcast: one stream byte painted onto every channel slot
      const broadcastByte = plan.broadcast ? (ai < stream.length ? stream[ai++] : 0) : null;
      for (const slot of slots) {
        const a = plan.broadcast ? broadcastByte : (ai < stream.length ? stream[ai++] : 0);
        const c = slot.ch;
        const op = ENCODE_OP[slot.combine];
        const keyModFn = KEY_MOD[slot.combine];
        if (keyModFn) {
          const mk = keyModFn(a, k[c], cur[c]);
          outK[c] = mk;
          outD[c] = op(a, mk, cur[c]);
          keyTouched = true;
        } else {
          outD[c] = op(a, k[c], cur[c]);
        }
      }
      img.set(dx, dy, outD[0], outD[1], outD[2]);
      if (keyTouched) img.set(kx, ky, outK[0], outK[1], outK[2]);
    }
  }

  function _readInterior(img, keyImg, byteLength, opts) {
    const B = opts.borderWidth || 1;
    const IW = img.width - 2 * B,
      IH = img.height - 2 * B;
    const path = getPathIndices(
      IW,
      IH,
      opts.traversal || "raster",
      opts.params || {},
    );
    const plan = _resolvePlan(opts);
    const slots = plan.slots;
    const km = KEYMAP[opts.keyMap || "adjacent"];
    if (!km) throw new Error(`unknown keymap: ${opts.keyMap}`);
    const params = opts.params || {};
    const out = new Uint8Array(byteLength);
    let ai = 0;
    for (let pi = 0; pi < path.length; pi++) {
      if (ai >= byteLength) break;
      const v = path[pi];
      const lx = v % IW,
        ly = (v / IW) | 0;
      const [klx, kly] = km(lx, ly, IW, IH, params);
      const dx = lx + B,
        dy = ly + B,
        kx = klx + B,
        ky = kly + B;
      const e_ = img.get(dx, dy),
        k = keyImg.get(kx, ky);
      // broadcast: decode from first slot only (all channels carry the same byte)
      if (plan.broadcast) {
        if (ai >= byteLength) break;
        const s0 = slots[0];
        out[ai++] = COMBINE[s0.combine](e_[s0.ch], k[s0.ch]);
      } else {
        for (const slot of slots) {
          if (ai >= byteLength) break;
          out[ai++] = COMBINE[slot.combine](e_[slot.ch], k[slot.ch]);
        }
      }
    }
    return out;
  }

  // ---- encode / decode container ----------------------------
  // Write the header into the border alpha, each byte riding two pixels as
  // high/low nibbles (alpha = 255 - nibble) so every header pixel stays at
  // alpha >= 240. Raw bytes per pixel rendered the header as a nearly
  // transparent strip along the border. A zero byte lands on alpha 255
  // exactly, so no zero-clamping is needed on this layout.
  // B rides bytes at ring index 0-1; B > 255 uses a 0 sentinel there and
  // two more bytes after it. Default offset centres the header in the
  // bottom row. Must be called AFTER the interior write, since KEY_MOD ops
  // may reset border alpha to 255.
  function _applyAlphaHeader(outImg, B, hdrBytes, offset) {
    const bpx = getBorderPixels(outImg.width, outImg.height, B);
    const putByte = (index, byte) => {
      outImg.setAlpha(bpx[index][0], bpx[index][1], 255 - ((byte >> 4) & 0xf));
      outImg.setAlpha(bpx[index + 1][0], bpx[index + 1][1], 255 - (byte & 0xf));
    };
    let minOffset;
    if (B > 255) {
      putByte(0, 0); // sentinel
      putByte(2, B & 0xff);
      putByte(4, (B >> 8) & 0xff);
      minOffset = 6;
    } else {
      putByte(0, B);
      minOffset = 2;
    }

    const headerPx = hdrBytes.length * 2;
    if (minOffset + headerPx > bpx.length)
      throw new Error("STGC header does not fit the border ring");

    if (offset == null) {
      // center in bottom row: find first bottom-row pixel in border sequence
      const H = outImg.height;
      const bottomStart = bpx.findIndex(([, py]) => py === H - 1);
      const bottomLen = outImg.width;
      offset = bottomStart + ((bottomLen - headerPx) >> 1);
    }
    // The ring is contiguous in index space and decode scans all of it, so a
    // header that cannot centre in the bottom row simply starts earlier and
    // flows across the other border pixels.
    offset = Math.min(offset, bpx.length - headerPx);
    // even ring index, so decode can pair pixels deterministically from 0
    offset = Math.max(minOffset, offset) & ~1;
    for (let i = 0; i < hdrBytes.length; i++)
      putByte(offset + i * 2, hdrBytes[i]);
  }

  function encodeContainer(entries, srcImg, keyImg, opts) {
    const B = opts.borderWidth || 1;
    const W = srcImg.width,
      H = srcImg.height;
    const outImg = new Img(W, H, new Uint8Array(srcImg.data));

    // Resolve the channel plan (default = packed r,g,b + opts.combine). Alignment
    // pad depends on the entry-table size, so compute it before building the stream.
    const plan =
      opts.plan ||
      normalizeChannelPlan(opts, opts.bytesPerSample ?? 3, _tableSize(entries));
    const stream = buildInteriorStream(entries, plan.pad);

    const params = { ...(opts.params || {}) };
    if (
      (opts.traversal || "raster") === "fisher-yates" &&
      params.seed == null
    ) {
      params.seed = (Math.random() * 0x100000000) >>> 0;
    }

    const hdrBytes = packStgcHeader({
      combine: opts.combine || "xor",
      keyMap: opts.keyMap || "adjacent",
      traversal: opts.traversal || "raster",
      interiorByteLength: stream.length,
      entryCount: entries.length,
      params,
      // omit channel-plan fields for the legacy default or mono (pack=mono in header suffices)
      ch: (_isDefaultPlan(plan) || plan.broadcast) ? undefined : serializeChannelPlan(plan.slots),
      pad: plan.pad,
      pack: plan.pack,
    });

    // each header byte rides two border pixels, plus the B bootstrap
    const headerPx = hdrBytes.length * 2 + 2;
    if (headerPx > borderPixelCount(W, H, B))
      throw new Error(
        `border ring too small for STGC header (need ${headerPx}px, ring has ${borderPixelCount(W, H, B)})`,
      );

    _writeInterior(outImg, keyImg, stream, { ...opts, params, plan });

    // apply after interior write: combine ops with KEY_MOD may reset border pixel alpha to 255
    _applyAlphaHeader(outImg, B, hdrBytes, opts.headerOffset ?? null);

    return outImg;
  }

  function decodeContainer(encImg, keyImg) {
    const hdr = unpackStgcHeaderAlpha(encImg);
    const B = hdr.B;
    // Rebuild the channel plan from the header.
    let plan;
    if (hdr.pack === "mono") {
      plan = normalizeChannelPlan({ combine: hdr.combine, pack: "mono" });
    } else if (hdr.ch) {
      const slots = parseChannelPlan(hdr.ch);
      plan = { slots, pad: hdr.pad || 0, pack: hdr.pack, bytesPerPixel: slots.length };
    } else {
      plan = normalizeChannelPlan({ combine: hdr.combine });
    }
    plan.pad = hdr.pad || 0;
    const opts = {
      borderWidth: B,
      combine: hdr.combine,
      keyMap: hdr.keyMap,
      traversal: hdr.traversal,
      params: hdr.params,
      plan,
      pack: hdr.pack,
      // total encoded interior bytes — lets callers limit reconstruction to the
      // pixels that actually carry data (the tail past this is untouched original)
      interiorByteLength: hdr.interiorByteLength,
    };

    const stream = _readInterior(encImg, keyImg, hdr.interiorByteLength, opts);
    const meta = parseEntryTable(stream, hdr.entryCount, plan.pad);

    const entries = meta.map((m) => ({
      mimetype: m.mimetype,
      name: m.name,
      data: stream.slice(m.dataOffset, m.dataOffset + m.payloadLen),
      dataOffset: m.dataOffset,
    }));
    return { entries, opts };
  }

  // ---- PCM conversion (used by audio entries) ---------------
  function toFloat32(pcm, bps) {
    const n = (pcm.length / (bps >> 3)) | 0;
    const f = new Float32Array(n);
    if (bps === 8) {
      for (let i = 0; i < n; i++) f[i] = (pcm[i] - 128) / 128;
    } else if (bps === 16) {
      // unsigned big-endian: MSB first → matches float32ToPcm packing
      for (let i = 0; i < n; i++)
        f[i] = (pcm[i * 2] * 256 + pcm[i * 2 + 1]) / 32767.5 - 1;
    } else if (bps === 24) {
      // unsigned big-endian: MSB first → matches float32ToPcm packing
      for (let i = 0; i < n; i++)
        f[i] =
          (pcm[i * 3] * 65536 + pcm[i * 3 + 1] * 256 + pcm[i * 3 + 2]) /
            8388607.5 -
          1;
    }
    return f;
  }

  // peakNormalize: scale per-channel float audio so the loudest sample across
  // ALL channels lands at `targetDb` dBFS. A single shared gain is applied to
  // every channel, preserving inter-channel balance (stereo imaging — and thus
  // the resulting pixel pattern). Mutates the channel arrays in place and
  // returns the same `mixed` array. No-op on silence. Works identically in Node
  // and the browser (pure float math), so both encoders call it at the same
  // pipeline point — after mix/resample, before layoutChannels/float32ToPcm.
  // targetDb should be <= 0; with target linear <= 1 the new peak == target, so
  // float32ToPcm never clips. dir/reverse is irrelevant (peak is order-free).
  function peakNormalize(mixed, { targetDb = -1 } = {}) {
    if (!mixed || !mixed.length) return mixed;
    let peak = 0;
    for (const ch of mixed)
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
      }
    if (peak === 0) return mixed; // pure silence — nothing to scale
    const target = Math.pow(10, targetDb / 20); // dBFS → linear amplitude
    const gain = target / peak;
    for (const ch of mixed)
      for (let i = 0; i < ch.length; i++) ch[i] *= gain;
    return mixed;
  }

  function float32ToPcm(samples, bps) {
    const out = new Uint8Array(samples.length * (bps >> 3));
    if (bps === 8) {
      for (let i = 0; i < samples.length; i++)
        out[i] = Math.max(
          0,
          Math.min(255, Math.round((samples[i] + 1) * 127.5)),
        );
    } else if (bps === 16) {
      // unsigned big-endian: MSB→R, LSB→G — matches OLD's abacus channel assignment
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(
          0,
          Math.min(65535, Math.floor((samples[i] + 1) * 32767.5)),
        );
        out[i * 2] = v >>> 8;
        out[i * 2 + 1] = v & 0xff;
      }
    } else if (bps === 24) {
      // unsigned big-endian: MSB→R, mid→G, LSB→B — coarsest amplitude in most-visible channel
      for (let i = 0; i < samples.length; i++) {
        const v = Math.max(
          0,
          Math.min(16777215, Math.floor((samples[i] + 1) * 8388607.5)),
        );
        out[i * 3] = v >>> 16;
        out[i * 3 + 1] = (v >>> 8) & 0xff;
        out[i * 3 + 2] = v & 0xff;
      }
    }
    return out;
  }

  // ---- public surface ----------------------------------------
  return {
    Img,
    isDataPixel,
    isBorderPixel,
    getBorderPixels,
    dataPixelCount,
    borderPixelCount,
    KEYMAP_NAMES,
    KEYMAP,
    COMBINE_NAMES,
    COMBINE,
    ENCODE_OP,
    KEY_MOD,
    CHANNEL_NAMES,
    PACK_NAMES,
    normalizeChannelPlan,
    serializeChannelPlan,
    parseChannelPlan,
    TRAVERSAL_NAMES,
    TRAVERSALS,
    getPath,
    getPathIndices,
    scaleImg,
    autoScaleImg,
    interiorDims,
    resolveBorderWidth,
    stgcHeaderWidth,
    CODEC_VERSION,
    STGC_MAGIC,
    STGC_VERSION,
    buildDescriptor,
    parseDescriptor,
    packStgcHeader,
    unpackStgcHeaderAlpha,
    buildAudioMime,
    parseAudioMime,
    layoutChannels,
    unlayoutChannels,
    computeRevealOrder,
    KEY_PRESERVING,
    computeRecon,
    buildInteriorStream,
    parseEntryTable,
    containerInteriorBytes,
    encodeContainer,
    decodeContainer,
    toFloat32,
    peakNormalize,
    float32ToPcm,
  };
})();

if (typeof module !== "undefined") module.exports = StegCore;
