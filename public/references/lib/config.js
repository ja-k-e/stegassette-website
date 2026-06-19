"use strict";
// ============================================================
// config.js — canonical stegassette job/config schema shared by
// the Node batch encoder (jobs/*.json) and the browser editor.
//
// One JSON shape, one resolver. A jobs/*.json file can be pasted
// straight into the editor, and the editor can emit a jobs file.
// Units are MILLISECONDS throughout (start/end), matching batch jobs;
// the editor converts its internal seconds at the boundary.
//
// Works in Node (require) and the browser (script-tag global StegConfig,
// expects StegCore to already be loaded as a global).
// ============================================================

const StegConfig = (() => {
  const Core =
    typeof module !== "undefined" && module.exports
      ? require("./steg-core.js")
      : typeof StegCore !== "undefined"
        ? StegCore
        : null;

  // Canonical field defaults (omitted fields fall back to these).
  const DEFAULTS = {
    // file refs — batch-only; the editor ignores these on import (it uses
    // dropped files) and may stub/omit them on export.
    image: null,
    audio: null,
    out: null,
    // trim (milliseconds)
    start: 0,
    end: null,
    // audio
    sr: 22050,
    ch: 1,
    bits: 16,
    dir: "fwd", // fwd | rev
    mode: "relabel", // relabel | resample
    // peak normalization: null/false/"off" = off (default). true = on at the
    // default target (-1 dBFS). a number = on, that dBFS target (<= 0).
    normalize: null,
    layout: "planar", // planar | interleaved | block
    blockSize: 64,
    // effects
    combine: "xor",
    traversal: "raster",
    keymap: "adjacent",
    border: 0,
    aspect: null, // "original" | "16:9" | [W,H] | number | null
    seed: null, // fisher-yates
    angleA: 1, // angle traversal
    angleB: 1,
    kx: 0, // offset keymap
    ky: 0,
    // channel plan
    pack: "packed", // packed | aligned
    channels: null, // null = default (all 3, r→g→b, shared combine);
    //                 else array of { ch, combine } | letter string | token
    // entries — ordered array of { path, mimetype?, name?, ...audioParams } |
    //           { text, name? } objects. At least one audio entry required for encode.
    entries: [],
  };

  // Enum option lists — single source of truth for dropdowns + validation.
  // Falls back to literals if Core isn't present (defensive).
  const ENUMS = {
    combine: (Core && Core.COMBINE_NAMES) || [
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
    ],
    keymap: (Core && Core.KEYMAP_NAMES) || [
      "adjacent",
      "poles",
      "mirror-x",
      "mirror-y",
      "offset",
      "rotate",
    ],
    traversal: (Core && Core.TRAVERSAL_NAMES) || [
      "raster",
      "boustrophedon",
      "spiral",
      "angle",
      "fisher-yates",
      "center-out",
      "hilbert",
      "polar",
      "bayer",
    ],
    pack: (Core && Core.PACK_NAMES) || ["packed", "aligned", "mono"],
    channel: (Core && Core.CHANNEL_NAMES) || ["r", "g", "b"],
    dir: ["fwd", "rev"],
    mode: ["relabel", "resample"],
    layout: ["planar", "interleaved", "block"],
    bits: [8, 16, 24],
  };

  // Default peak-normalization target (dBFS) when normalize is enabled as a
  // bare flag (true / "on") without an explicit level.
  const NORMALIZE_DEFAULT_DB = -1;

  // Resolve a `normalize` spec to a target dBFS number, or null when off.
  //   null / false / "off" / "" / "none" → null (off)
  //   true / "on" / "yes"                → NORMALIZE_DEFAULT_DB
  //   number / numeric string            → that dBFS, clamped to <= 0
  function resolveNormalize(spec) {
    if (spec == null || spec === false) return null;
    if (spec === true) return NORMALIZE_DEFAULT_DB;
    if (typeof spec === "string") {
      const s = spec.trim().toLowerCase();
      if (s === "" || s === "off" || s === "none" || s === "false") return null;
      if (s === "on" || s === "yes" || s === "true") return NORMALIZE_DEFAULT_DB;
      const n = parseFloat(s);
      return Number.isFinite(n) ? Math.min(0, n) : NORMALIZE_DEFAULT_DB;
    }
    if (typeof spec === "number")
      return Number.isFinite(spec) ? Math.min(0, spec) : null;
    return null;
  }

  // Normalize an aspect spec to a numeric ratio (or null = keep original).
  function resolveAspect(aspect) {
    if (!aspect || aspect === "original") return null;
    if (typeof aspect === "string" && aspect.includes(":")) {
      const [aw, ah] = aspect.split(":").map(Number);
      return aw && ah ? aw / ah : null;
    }
    if (Array.isArray(aspect) && aspect.length === 2)
      return aspect[0] / aspect[1];
    if (typeof aspect === "number") return aspect;
    return null;
  }

  // Merge a partial job over DEFAULTS, tolerating hyphenated angle keys.
  function withDefaults(job = {}) {
    const j = { ...DEFAULTS, ...job };
    if (job["angle-a"] != null) j.angleA = job["angle-a"];
    if (job["angle-b"] != null) j.angleB = job["angle-b"];
    return j;
  }

  // resolveConfig(job) → fully-resolved settings used by both encoders.
  // Returns normalized audio params, steg effect params, the channel-plan
  // inputs, and a ready-to-use `encodeOpts` object for StegCore.encodeContainer.
  function resolveConfig(job = {}) {
    const j = withDefaults(job);

    const sr = parseInt(j.sr) || 22050;
    const ch = parseInt(j.ch) || 1;
    const bits = parseInt(j.bits) || 16;
    const bytesPerSample = bits >> 3;
    // border >= 1 → explicit extra px (legacy). 0 < border < 1 → fraction of the
    // output width, resolved by the encode runner once the payload size is known
    // (see StegCore.resolveBorderWidth). borderWidth here is a placeholder in the
    // fractional case; the runner overwrites it before encoding.
    const borderRaw = Number(j.border) || 0;
    const borderFraction = borderRaw > 0 && borderRaw < 1 ? borderRaw : 0;
    const borderWidth = borderFraction
      ? 1
      : 1 + Math.max(0, Math.floor(borderRaw));

    // peak normalization: resolve to a target dBFS number, or null when off.
    // null/false/"off"/"" → off; true → default target; number/numeric string →
    // that target (clamped to <= 0 so the normalized peak never forces clipping).
    const normalizeDb = resolveNormalize(j.normalize);

    const layout = ch > 1 ? j.layout || "planar" : "planar";
    const blockSize =
      layout === "block" ? Math.max(1, parseInt(j.blockSize) || 64) : 0;

    const params = {};
    if (j.traversal === "fisher-yates") {
      if (j.seed != null) params.seed = j.seed >>> 0;
    } else if (j.traversal === "angle") {
      params.a = j.angleA;
      params.b = j.angleB;
    }
    if (j.keymap === "offset") {
      params.kx = j.kx | 0;
      params.ky = j.ky | 0;
    }

    const encodeOpts = {
      combine: j.combine || "xor",
      traversal: j.traversal || "raster",
      keyMap: j.keymap || "adjacent",
      borderWidth,
      borderFraction,
      params,
      pack: j.pack === "aligned" ? "aligned" : j.pack === "mono" ? "mono" : "packed",
      channels: j.channels || null,
      bytesPerSample,
    };

    return {
      files: { image: j.image, audio: j.audio, out: j.out },
      trim: { start: j.start | 0, end: j.end == null ? null : j.end | 0 },
      audio: {
        sr,
        ch,
        bits,
        dir: j.dir === "rev" ? "rev" : "fwd",
        mode: j.mode === "resample" ? "resample" : "relabel",
        normalizeDb,
        layout,
        blockSize,
        bytesPerSample,
      },
      aspectOverride: resolveAspect(j.aspect),
      // `entries` is canonical; fall back to `texts` for old jobs files.
      entries: Array.isArray(j.entries) ? j.entries
        : Array.isArray(j.texts) ? j.texts : [],
      encodeOpts,
    };
  }

  // Validate enum-bearing fields; returns an array of human-readable warnings
  // (empty = clean). Used by the editor when importing pasted JSON.
  function validateConfig(job = {}) {
    const warn = [];
    const inEnum = (k, list) => {
      if (job[k] != null && !list.includes(job[k]))
        warn.push(`${k}="${job[k]}" is not one of: ${list.join(", ")}`);
    };
    inEnum("combine", ENUMS.combine);
    inEnum("keymap", ENUMS.keymap);
    inEnum("traversal", ENUMS.traversal);
    inEnum("pack", ENUMS.pack);
    inEnum("dir", ENUMS.dir);
    inEnum("mode", ENUMS.mode);
    inEnum("layout", ENUMS.layout);
    if (job.bits != null && !ENUMS.bits.includes(parseInt(job.bits)))
      warn.push(`bits=${job.bits} is not one of: ${ENUMS.bits.join(", ")}`);
    // channel-plan combines
    const ch = job.channels;
    const combos = [];
    if (Array.isArray(ch))
      for (const s of ch)
        if (s && typeof s === "object" && s.combine) combos.push(s.combine);
    if (typeof ch === "string" && ch.includes("."))
      for (const t of ch.split("+")) {
        const c = t.split(".")[1];
        if (c) combos.push(c);
      }
    for (const c of combos)
      if (!ENUMS.combine.includes(c))
        warn.push(`channel combine "${c}" is not one of: ${ENUMS.combine.join(", ")}`);
    return warn;
  }

  return {
    DEFAULTS,
    ENUMS,
    NORMALIZE_DEFAULT_DB,
    resolveConfig,
    validateConfig,
    resolveAspect,
    resolveNormalize,
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = StegConfig;
