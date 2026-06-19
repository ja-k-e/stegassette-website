import { getKeyCoords, getTraversalPath, isDataPixel, operations, simAudio, simKey } from "./operations.js";

const orange = [255, 92, 0];
const darkOrange = [45, 15, 0];
const white = [255, 255, 255];
const darkGray = [28, 28, 28];

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function rgb([r, g, b]) {
  return `rgb(${r}, ${g}, ${b})`;
}

export function drawRecordTexture(canvas, record, options = {}) {
  const ctx = canvas.getContext("2d");
  const size = options.size || canvas.width || 320;
  const cells = options.cells || 32;
  const cell = size / cells;
  canvas.width = size;
  canvas.height = size;
  ctx.fillStyle = "#080808";
  ctx.fillRect(0, 0, size, size);

  const path = getTraversalPath(cells - 2, cells - 2, record.traversal);
  const order = new Map(path.map(([x, y], index) => [`${x + 1}:${y + 1}`, index]));
  const op = operations[record.combine] || operations.xor;

  for (let y = 0; y < cells; y += 1) {
    for (let x = 0; x < cells; x += 1) {
      const innerX = x - 1;
      const innerY = y - 1;
      const border = innerX < 0 || innerY < 0 || innerX >= cells - 2 || innerY >= cells - 2;
      let fill = "#120c08";

      if (!border) {
        if (isDataPixel(innerX, innerY)) {
          const index = order.get(`${x}:${y}`) || 0;
          const [kx, ky] = getKeyCoords(innerX, innerY, cells - 2, cells - 2, record.keymap);
          const value = op.encode(simAudio(index, record.seed), simKey(kx, ky, record.seed));
          const tone = Math.round(value * 0.5 + 24);
          const tint = mix(orange, darkOrange, index / Math.max(1, path.length - 1));
          fill = `rgb(${Math.max(tone, tint[0] * 0.32)}, ${Math.round(tone * 0.32)}, ${Math.round(tint[2] * 0.18)})`;
        } else {
          const key = simKey(innerX, innerY, record.seed);
          fill = `rgb(${Math.round(key * 0.08)}, ${Math.round(key * 0.1)}, ${Math.round(key * 0.18)})`;
        }
      }

      ctx.fillStyle = fill;
      ctx.fillRect(x * cell, y * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
}

export function createRecordImage(record, size = 320) {
  const canvas = document.createElement("canvas");
  drawRecordTexture(canvas, record, { size });
  return canvas.toDataURL("image/png");
}

export function drawFeature(canvas, record, progress = 0) {
  drawRecordTexture(canvas, record, { size: canvas.width, cells: 40 });
  const ctx = canvas.getContext("2d");
  const x = Math.floor((canvas.width - 2) * progress);
  ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
  ctx.fillRect(x, 0, 2, canvas.height);
  ctx.fillStyle = "rgba(255, 92, 0, 0.72)";
  ctx.fillRect(0, canvas.height - 12, Math.max(2, canvas.width * progress), 12);
}

export function drawExplorer(canvas, state) {
  const ctx = canvas.getContext("2d");
  const width = 12;
  const height = 12;
  const border = 1;
  const cell = canvas.width / (width + border * 2);
  const path = getTraversalPath(width, height, state.traversal);
  const step = state.step % path.length;
  const [dx, dy] = path[step];
  const [kx, ky] = getKeyCoords(dx, dy, width, height, state.keymap);

  ctx.fillStyle = "#090909";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const order = new Map(path.map(([x, y], index) => [`${x}:${y}`, index]));
  for (let y = 0; y < height + border * 2; y += 1) {
    for (let x = 0; x < width + border * 2; x += 1) {
      const ix = x - border;
      const iy = y - border;
      const isBorder = ix < 0 || iy < 0 || ix >= width || iy >= height;
      let fill = "#1a1a1a";
      if (isBorder) {
        fill = "#141414";
      } else if (!isDataPixel(ix, iy)) {
        // Key pixel: orange when active, dark orange when inactive
        fill = ix === kx && iy === ky ? "#ff5c00" : "#2a1000";
      } else {
        const index = order.get(`${ix}:${iy}`) ?? -1;
        if (ix === dx && iy === dy) {
          // Current data pixel: bright white
          fill = "#ffffff";
        } else if (index >= 0 && index < step) {
          // Past data pixels: recently visited = bright, oldest = dark gray
          const brightness = index / Math.max(1, step - 1);
          const tone = Math.round(30 + brightness * 180);
          fill = `rgb(${tone}, ${tone}, ${tone})`;
        } else {
          fill = "#111";
        }
      }
      ctx.fillStyle = fill;
      ctx.fillRect(x * cell, y * cell, Math.ceil(cell - 1), Math.ceil(cell - 1));
    }
  }

  return {
    step,
    total: path.length,
    data: [dx, dy],
    key: [kx, ky],
    audio: simAudio(step, 1),
    keyValue: simKey(kx, ky, 1),
  };
}

export function drawMiniTraversal(canvas, name, offset = 0) {
  const ctx = canvas.getContext("2d");
  const width = 12;
  const height = 12;
  const cell = canvas.width / 14;
  const path = getTraversalPath(width, height, name);
  const reveal = Math.floor((path.length * ((Date.now() + offset) % 2800)) / 2800);
  const order = new Map(path.map(([x, y], index) => [`${x}:${y}`, index]));
  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < 14; y += 1) {
    for (let x = 0; x < 14; x += 1) {
      const ix = x - 1;
      const iy = y - 1;
      let fill = "#181818";
      if (ix >= 0 && iy >= 0 && ix < width && iy < height) {
        if (!isDataPixel(ix, iy)) fill = "#171717";
        else {
          const index = order.get(`${ix}:${iy}`) ?? -1;
          // White scale: recently revealed = bright, older = darker gray
          fill = index <= reveal ? rgb(mix(white, darkGray, index / path.length)) : "#101010";
        }
      }
      ctx.fillStyle = fill;
      ctx.fillRect(x * cell, y * cell, Math.ceil(cell - 1), Math.ceil(cell - 1));
    }
  }
}

export function drawMiniKeymap(canvas, name, offset = 0) {
  const ctx = canvas.getContext("2d");
  // Match traversal's 12×12 inner grid (14×14 total with 1-cell border)
  const width = 12;
  const height = 12;
  const border = 1;
  const cell = canvas.width / (width + border * 2);
  const dataPixels = [];
  const highlight = Math.floor(((Date.now() + offset) % 2400) / 2400 * (width * height / 2));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isDataPixel(x, y)) dataPixels.push([x, y]);
    }
  }

  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < height + border * 2; y += 1) {
    for (let x = 0; x < width + border * 2; x += 1) {
      const ix = x - border;
      const iy = y - border;
      const isBorder = ix < 0 || iy < 0 || ix >= width || iy >= height;
      let fill = "#181818";
      if (isBorder) fill = "#141414";
      else if (isDataPixel(ix, iy)) fill = "#1a1a1a";
      else fill = "#2a1000";
      ctx.fillStyle = fill;
      ctx.fillRect(x * cell, y * cell, Math.ceil(cell - 1), Math.ceil(cell - 1));
    }
  }

  // Draw data/key pixel highlights — same cell coords as background
  const cellSize = Math.ceil(cell - 1);
  dataPixels.forEach(([dx, dy], index) => {
    const [kx, ky] = getKeyCoords(dx, dy, width, height, name);
    const active = index === highlight % dataPixels.length;
    ctx.fillStyle = active ? "#ffffff" : "#333333";
    ctx.fillRect((dx + border) * cell, (dy + border) * cell, cellSize, cellSize);
    ctx.fillStyle = active ? "#ff5c00" : "#3a1200";
    ctx.fillRect((kx + border) * cell, (ky + border) * cell, cellSize, cellSize);
  });
}
