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

function loadImageData(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(image, 0, 0);
      resolve({
        canvas,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        width: canvas.width,
        height: canvas.height,
      });
    };
    image.onerror = reject;
    image.src = src;
  });
}

function drawImageDataToCanvas(data, width, height, outWidth = width, outHeight = height) {
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  source.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
  const target = document.createElement("canvas");
  target.width = outWidth;
  target.height = outHeight;
  const ctx = target.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, outWidth, outHeight);
  return target;
}

function xyFromPath(pathIdx, index, interiorWidth, border) {
  const value = pathIdx[index];
  return [(value % interiorWidth) + border, ((value / interiorWidth) | 0) + border];
}

function clearOverlayAt(state, pathIndex) {
  const { overlayCtx, pathIdx, interiorWidth, interiorHeight, border, opts } = state;
  if (pathIndex < 0 || pathIndex >= pathIdx.length) return;
  const value = pathIdx[pathIndex];
  const lx = value % interiorWidth;
  const ly = (value / interiorWidth) | 0;
  overlayCtx.clearRect(lx + border, ly + border, 1, 1);
  const keyMap = window.StegCore.KEYMAP[opts.keyMap || "adjacent"];
  const [kx, ky] = keyMap(lx, ly, interiorWidth, interiorHeight, opts.params || {});
  overlayCtx.clearRect(kx + border, ky + border, 1, 1);
}

function fillNonAudioPixels(state) {
  const { audioStartPxIdx, audioEndPxIdx, pathIdx } = state;
  for (let i = 0; i < audioStartPxIdx; i += 1) clearOverlayAt(state, i);
  for (let i = audioEndPxIdx; i < pathIdx.length; i += 1) clearOverlayAt(state, i);
}

function reconstructPixels({ px, width, height, opts, pathIdx }) {
  const border = opts.borderWidth;
  const interiorWidth = width - 2 * border;
  const interiorHeight = height - 2 * border;
  const bytesPerPixel = opts.plan ? opts.plan.bytesPerPixel || opts.plan.slots.length : 3;
  const planSlots = opts.plan ? opts.plan.slots : [0, 1, 2].map((ch) => ({ ch, combine: opts.combine }));
  const chCombine = [null, null, null];
  for (const slot of planSlots) chCombine[slot.ch] = slot.combine;
  const realOnly = chCombine.every((combine) => combine == null || KEY_PRESERVING.has(combine));
  const hasKeyPreserving = chCombine.some((combine) => combine != null && KEY_PRESERVING.has(combine));

  let reconData;
  let reconWidth;
  let reconHeight;

  if (realOnly) {
    reconWidth = (width + 1) >> 1;
    reconHeight = (height + 1) >> 1;
    reconData = new Uint8ClampedArray(reconWidth * reconHeight * 4);
    for (let by = 0; by < reconHeight; by += 1) {
      for (let bx = 0; bx < reconWidth; bx += 1) {
        const x0 = bx << 1;
        const y0 = by << 1;
        const tl = (y0 * width + x0) * 4;
        const x1 = x0 + 1;
        const y1 = y0 + 1;
        const hasBR = x1 < width && y1 < height;
        const br = hasBR ? (y1 * width + x1) * 4 : tl;
        const out = (by * reconWidth + bx) * 4;
        for (let ch = 0; ch < 3; ch += 1) {
          const mask = { midpoint: 0xfe, veil: 0xfc, whisper: 0xf0 }[chCombine[ch]] ?? 0xff;
          reconData[out + ch] = hasBR ? ((px[tl + ch] & mask) + (px[br + ch] & mask) + 1) >> 1 : px[tl + ch] & mask;
        }
        reconData[out + 3] = 255;
      }
    }
    return { reconData, reconWidth, reconHeight };
  }

  reconWidth = width;
  reconHeight = height;
  reconData = new Uint8ClampedArray(px);
  const keyMap = window.StegCore.KEYMAP[opts.keyMap || "adjacent"];
  const encodedPixels = Math.min(pathIdx.length, Math.ceil((opts.interiorByteLength || 0) / bytesPerPixel));

  for (let index = 0; index < encodedPixels; index += 1) {
    const [dx, dy] = xyFromPath(pathIdx, index, interiorWidth, border);
    const dataOffset = (dy * width + dx) * 4;
    for (let ch = 0; ch < 3; ch += 1) {
      if (chCombine[ch] == null) continue;
      const mask = chCombine[ch] === "midpoint" ? 0xfe : 0xff;
      let acc = 0;
      let count = 0;
      for (const [nx, ny] of [[dx - 1, dy], [dx + 1, dy], [dx, dy - 1], [dx, dy + 1]]) {
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
          acc += px[(ny * width + nx) * 4 + ch] & mask;
          count += 1;
        }
      }
      reconData[dataOffset + ch] = count ? Math.round(acc / count) : 0;
    }
  }

  for (let index = 0; index < encodedPixels; index += 1) {
    const value = pathIdx[index];
    const lx = value % interiorWidth;
    const ly = (value / interiorWidth) | 0;
    const [klx, kly] = keyMap(lx, ly, interiorWidth, interiorHeight, opts.params || {});
    const [dx, dy] = [lx + border, ly + border];
    const [kx, ky] = [klx + border, kly + border];
    const dataOffset = (dy * width + dx) * 4;
    const keyOffset = (ky * width + kx) * 4;
    for (let ch = 0; ch < 3; ch += 1) {
      if (chCombine[ch] === "midpoint") {
        reconData[keyOffset + ch] &= 0xfe;
      } else if (chCombine[ch] === "difference") {
        let source = px[keyOffset + ch];
        const data = px[dataOffset + ch];
        if (source < data) source += 256;
        const midpoint = Math.round((source - data) / 2 + data) & 0xff;
        reconData[dataOffset + ch] = midpoint;
        reconData[keyOffset + ch] = midpoint;
      } else if (chCombine[ch] === "echo") {
        reconData[keyOffset + ch] = px[keyOffset + ch] ^ px[dataOffset + ch];
      }
    }
  }

  if (!hasKeyPreserving) return { reconData, reconWidth, reconHeight };

  const halfWidth = (width + 1) >> 1;
  const halfHeight = (height + 1) >> 1;
  const half = new Uint8ClampedArray(halfWidth * halfHeight * 4);
  for (let by = 0; by < halfHeight; by += 1) {
    for (let bx = 0; bx < halfWidth; bx += 1) {
      const x0 = bx << 1;
      const y0 = by << 1;
      const tl = (y0 * width + x0) * 4;
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const hasBR = x1 < width && y1 < height;
      const br = hasBR ? (y1 * width + x1) * 4 : tl;
      const out = (by * halfWidth + bx) * 4;
      for (let ch = 0; ch < 3; ch += 1) half[out + ch] = hasBR ? (reconData[tl + ch] + reconData[br + ch] + 1) >> 1 : reconData[tl + ch];
      half[out + 3] = 255;
    }
  }
  return { reconData: half, reconWidth: halfWidth, reconHeight: halfHeight };
}

export async function createRevealState(record, frame) {
  if (!window.StegCore) throw new Error("StegCore is not loaded");
  const { canvas: encodedCanvas, data, width, height } = await loadImageData(record.imageUrl);
  const encImg = new window.StegCore.Img(width, height, new Uint8Array(data));
  const { entries, opts } = window.StegCore.decodeContainer(encImg, encImg);
  const border = opts.borderWidth;
  const interiorWidth = width - 2 * border;
  const interiorHeight = height - 2 * border;
  const pathIdx = window.StegCore.getPathIndices(interiorWidth, interiorHeight, opts.traversal, opts.params || {});
  const bytesPerPixel = opts.plan ? opts.plan.bytesPerPixel || opts.plan.slots.length : 3;
  const tracks = entries
    .filter((entry) => entry.mimetype.startsWith("audio/"))
    .map((entry) => {
      const { bits, rate, channels, layout, blockSize } = window.StegCore.parseAudioMime(entry.mimetype);
      const audioStartPxIdx = Math.floor(entry.dataOffset / bytesPerPixel);
      const audioEndPxIdx = Math.ceil((entry.dataOffset + entry.data.length) / bytesPerPixel);
      const pathLen = audioEndPxIdx - audioStartPxIdx;
      return {
        audioStartPxIdx,
        audioEndPxIdx,
        revealOrder: window.StegCore.computeRevealOrder({ pathLen, channels, bits, layout, blockSize, bytesPerPixel }),
        fillIdx: -1,
      };
    });
  const { reconData, reconWidth, reconHeight } = reconstructPixels({ px: data, width, height, opts, pathIdx });
  const reconCanvas = drawImageDataToCanvas(reconData, reconWidth, reconHeight, width, height);
  const visibleRecon = frame.querySelector(".spotlight-recon");
  const overlay = frame.querySelector(".spotlight-overlay");
  visibleRecon.width = overlay.width = width;
  visibleRecon.height = overlay.height = height;
  visibleRecon.getContext("2d").drawImage(reconCanvas, 0, 0);
  const overlayCtx = overlay.getContext("2d");
  const state = { overlay, overlayCtx, encodedCanvas, pathIdx, interiorWidth, interiorHeight, border, opts, tracks, audioStartPxIdx: Math.min(...tracks.map((track) => track.audioStartPxIdx)), audioEndPxIdx: Math.max(...tracks.map((track) => track.audioEndPxIdx)), lastProgress: -1 };
  resetRevealState(state);
  return state;
}

export function resetRevealState(state) {
  state.overlayCtx.clearRect(0, 0, state.overlay.width, state.overlay.height);
  state.overlayCtx.drawImage(state.encodedCanvas, 0, 0);
  fillNonAudioPixels(state);
  for (const track of state.tracks) track.fillIdx = -1;
  state.lastProgress = -1;
}

export function revealAtProgress(state, progress) {
  if (progress < state.lastProgress) resetRevealState(state);
  for (const track of state.tracks) {
    const pathLen = track.audioEndPxIdx - track.audioStartPxIdx;
    const revealIdx = Math.min(Math.floor(progress * pathLen), pathLen - 1);
    if (revealIdx + 1 > track.fillIdx) {
      const start = Math.max(0, track.fillIdx);
      for (let i = start; i <= revealIdx; i += 1) clearOverlayAt(state, track.audioStartPxIdx + track.revealOrder[i]);
      track.fillIdx = revealIdx + 1;
    }
  }
  state.lastProgress = progress;
}
