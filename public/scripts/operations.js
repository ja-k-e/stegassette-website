export function rotateLeft(value, n) {
  return ((value << n) | (value >>> (8 - n))) & 0xff;
}

export function rotateRight(value, n) {
  return ((value >>> n) | (value << (8 - n))) & 0xff;
}

export const operations = {
  xor: {
    lossless: true,
    encode: (d, k) => d ^ k,
    decode: (e, k) => e ^ k,
    formula: "encode: stored = data xor key\ndecode: data = stored xor key",
  },
  additive: {
    lossless: true,
    encode: (d, k) => (d + k) & 0xff,
    decode: (e, k) => (e - k + 256) & 0xff,
    formula: "encode: stored = (data + key) mod 256\ndecode: data = (stored - key) mod 256",
  },
  subtractive: {
    lossless: true,
    encode: (d, k) => (d - k + 256) & 0xff,
    decode: (e, k) => (e + k) & 0xff,
    formula: "encode: stored = (data - key) mod 256\ndecode: data = (stored + key) mod 256",
  },
  midpoint: {
    lossless: false,
    encode: (d, k) => (d + k) >> 1,
    decode: (e, k) => ((e << 1) - k + 256) & 0xff,
    formula: "encode: stored = floor((data + key) / 2)\ndecode: data ~= 2 * stored - key",
  },
  difference: {
    lossless: false,
    encode: (d, k) => ((d - k + 256) >> 1) & 0xff,
    decode: (e, k) => ((e << 1) + k) & 0xff,
    formula: "encode: stored = floor((data - key) / 2)\ndecode: data ~= 2 * stored + key",
  },
  bitshift: {
    lossless: true,
    encode: (d, k) => rotateLeft(d, k & 7),
    decode: (e, k) => rotateRight(e, k & 7),
    formula: "encode: stored = rotL(data, key & 7)\ndecode: data = rotR(stored, key & 7)",
  },
  noise: {
    lossless: true,
    encode: (d, k) => d ^ (k ^ (k >> 1)),
    decode: (e, k) => e ^ (k ^ (k >> 1)),
    formula: "encode: stored = data xor gray(key)\ndecode: data = stored xor gray(key)",
  },
  echo: {
    lossless: true,
    encode: (d) => d,
    decode: (e) => e,
    formula: "encode: stored = data\nghost: data xor key\ndecode: data = stored",
  },
  signed: {
    lossless: true,
    encode: (d, k) => (k + d - 128 + 512) & 0xff,
    decode: (e, k) => (e - k + 128 + 512) & 0xff,
    formula: "encode: stored = key + (data - 128) mod 256\ndecode: data = stored - key + 128 mod 256",
  },
  veil: {
    lossless: false,
    encode: (d, k) => ((k * 3 + d) >> 2) & 0xff,
    decode: (e, k) => ((e << 2) - k * 3 + 1024) & 0xff,
    formula: "encode: stored = floor((3 * key + data) / 4)\ndecode: data ~= 4 * stored - 3 * key",
  },
  whisper: {
    lossless: false,
    encode: (d, k) => (k & 0x0f) | (d & 0xf0),
    decode: (e) => e & 0xf0,
    formula: "encode: stored = (key & 0x0f) | (data & 0xf0)\ndecode: data ~= stored & 0xf0",
  },
};

export function hex(value) {
  return `0x${(value & 0xff).toString(16).padStart(2, "0").toUpperCase()}`;
}

export function bits(value) {
  return (value & 0xff).toString(2).padStart(8, "0");
}

export function isDataPixel(x, y) {
  return y % 2 === 0 ? x % 2 === 1 : x % 2 === 0;
}

export function getTraversalPath(width, height, type) {
  const all = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isDataPixel(x, y)) all.push([x, y]);
    }
  }

  if (type === "boustrophedon") {
    return Array.from({ length: height }, (_, y) => {
      const row = all.filter(([, py]) => py === y);
      return y % 2 === 0 ? row : row.reverse();
    }).flat();
  }

  if (type === "spiral") {
    const seen = new Uint8Array(width * height);
    const out = [];
    const dx = [1, 0, -1, 0];
    const dy = [0, 1, 0, -1];
    let x = 0;
    let y = 0;
    let d = 0;
    for (let i = 0; i < width * height; i += 1) {
      if (isDataPixel(x, y)) out.push([x, y]);
      seen[y * width + x] = 1;
      let nx = x + dx[d];
      let ny = y + dy[d];
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || seen[ny * width + nx]) {
        d = (d + 1) % 4;
        nx = x + dx[d];
        ny = y + dy[d];
      }
      x = nx;
      y = ny;
    }
    return out;
  }

  if (type === "angle") {
    return [...all].sort(([ax, ay], [bx, by]) => ax + ay - (bx + by) || ay * width + ax - (by * width + bx));
  }

  if (type === "fisher-yates") {
    const out = [...all];
    let seed = (width * 1664525 + height * 1013904223) >>> 0;
    for (let i = out.length - 1; i > 0; i -= 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const j = seed % (i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  if (type === "center-out") {
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
    return [...all].sort(([ax, ay], [bx, by]) => (ax - cx) ** 2 + (ay - cy) ** 2 - ((bx - cx) ** 2 + (by - cy) ** 2));
  }

  if (type === "hilbert") {
    const size = 1 << Math.ceil(Math.log2(Math.max(width, height, 2)));
    const out = [];
    for (let t = 0; t < size * size; t += 1) {
      let hx = 0;
      let hy = 0;
      let tt = t;
      for (let s = 1; s < size; s <<= 1) {
        const rx = (tt >> 1) & 1;
        const ry = (tt ^ rx) & 1;
        if (ry === 0) {
          if (rx === 1) {
            hx = s - 1 - hx;
            hy = s - 1 - hy;
          }
          [hx, hy] = [hy, hx];
        }
        hx += s * rx;
        hy += s * ry;
        tt >>= 2;
      }
      if (hx < width && hy < height && isDataPixel(hx, hy)) out.push([hx, hy]);
    }
    return out;
  }

  if (type === "polar") {
    const rx = (x) => 2 * x - (width - 1);
    const ry = (y) => 2 * y - (height - 1);
    const half = (x, y) => (x > 0 || (x === 0 && y <= 0) ? 0 : 1);
    return [...all].sort(([ax, ay], [bx, by]) => {
      const arx = rx(ax);
      const ary = ry(ay);
      const brx = rx(bx);
      const bry = ry(by);
      const ha = half(arx, ary);
      const hb = half(brx, bry);
      if (ha !== hb) return ha - hb;
      const cross = arx * bry - ary * brx;
      if (cross !== 0) return cross > 0 ? -1 : 1;
      return arx * arx + ary * ary - (brx * brx + bry * bry);
    });
  }

  if (type === "bayer") {
    const maxBits = Math.max(1, Math.ceil(Math.log2(Math.max(width, height, 2))));
    const bayerValue = (x, y) => {
      let value = 0;
      for (let i = 0; i < maxBits; i += 1) {
        const xb = (x >> i) & 1;
        const yb = (y >> i) & 1;
        value = value * 4 + (((xb ^ yb) << 1) | yb);
      }
      return value;
    };
    return [...all].sort(([ax, ay], [bx, by]) => bayerValue(ax, ay) - bayerValue(bx, by));
  }

  return all;
}

export function getKeyCoords(x, y, width, height, keymap) {
  const wrap = (n, max) => ((n % max) + max) % max;
  const snap = (px, py) => {
    px = wrap(px, width);
    py = wrap(py, height);
    if (!isDataPixel(px, py)) return [px, py];
    return py % 2 === 0 ? [px - 1 < 0 ? px + 1 : px - 1, py] : [px + 1 >= width ? px - 1 : px + 1, py];
  };

  if (keymap === "poles") return snap(width - 1 - x, height - 1 - y);
  if (keymap === "mirror-x") return snap(width - 1 - x, y);
  if (keymap === "mirror-y") return snap(x, height - 1 - y);
  if (keymap === "offset") return snap(x + Math.round(width * 0.35), y + Math.round(height * 0.35));
  if (keymap === "rotate") {
    const px = Math.round((1 - y / Math.max(1, height - 1)) * (width - 1));
    const py = Math.round((x / Math.max(1, width - 1)) * (height - 1));
    return snap(px, py);
  }
  return y % 2 === 0 ? [Math.max(0, x - 1), y] : [Math.min(width - 1, x + 1), y];
}

export function simKey(x, y, seed = 0) {
  return ((x * 41 + y * 67 + seed * 13) ^ (x * y * 3)) & 0xff;
}

export function simAudio(step, seed = 0) {
  return Math.round((Math.sin(step * 0.23 + seed) * 0.75 + 0.25) * 120 + 30) & 0xff;
}
