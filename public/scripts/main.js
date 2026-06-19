import { combineInfo, keymapInfo, records, traversalInfo } from "./data.js";
import { bits, hex, operations } from "./operations.js";
import { drawExplorer, drawMiniKeymap, drawMiniTraversal } from "./pixel-grid.js";
import { Player } from "./player.js";
import { createRevealState, resetRevealState, revealAtProgress } from "./steg-reconstruction.js";
import { WebglHeader } from "./webgl-header.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const escapeHTML = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
const recordDetailId = (record) => `track-${record.index.toString().padStart(2, "0")}`;
const rgbChannels = ["r", "g", "b"];

function getChannelSlots(record) {
  if (Array.isArray(record.channels) && record.channels.length) {
    return record.channels
      .map((slot) => ({
        ch: String(slot.ch ?? slot.channel ?? "").toLowerCase(),
        combine: slot.combine || record.combine,
      }))
      .filter((slot) => rgbChannels.includes(slot.ch));
  }
  return rgbChannels.map((ch) => ({ ch, combine: record.combine }));
}

function channelPlanSummary(record) {
  const slots = getChannelSlots(record);
  const byChannel = new Map(slots.map((slot) => [slot.ch, slot.combine]));
  const values = rgbChannels.map((ch) => byChannel.get(ch) || "passthrough");
  if (values.every((value) => value === values[0])) return `RGB: ${values[0]}`;
  return rgbChannels.map((ch, index) => `${ch.toUpperCase()}:${values[index]}`).join(" · ");
}

function borderLabel(record) {
  return String(record.border ?? "").replace(/px$/i, "");
}

function linkifyDomains(value) {
  return String(value ?? "").replace(/https?:\/\/[^\s)]+/g, (match) => {
    const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
    const href = trailing ? match.slice(0, -trailing.length) : match;
    let label = href;
    try {
      label = new URL(href).hostname.replace(/^www\./, "");
    } catch {
      label = href;
    }
    return `<a href="${escapeHTML(href)}" target="_blank" rel="noreferrer">${escapeHTML(label)}</a>${escapeHTML(trailing)}`;
  });
}

function detailsWithSource(record) {
  const details = escapeHTML(record.details || record.metadataText || "");
  return linkifyDomains(details);
}

function songTitle(record) {
  const title = escapeHTML(record.song);
  if (!record.sourceUrl) return title;
  return `<a href="${escapeHTML(record.sourceUrl)}" target="_blank" rel="noreferrer">${title}</a>`;
}

function locationDateLabel(record) {
  const parts = [record.location, record.date].filter(Boolean);
  return parts.length ? parts.join(", ") : "unknown";
}

function selectRecord(player, record, { autoplay = true, scroll = false } = {}) {
  player.load(record, autoplay);
  if (scroll) {
    const target = document.getElementById(recordDetailId(record));
    scrollDetailIntoView(target);
  }
}

function scrollDetailIntoView(target) {
  if (!target) return;
  target.scrollIntoView({ block: "start", behavior: "smooth" });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Unable to load image: ${src}`));
    image.src = src;
  });
}

let selectedRecord = records[0];
let selectedCombine = selectedRecord.combine;
let playRequestId = 0;
let explorerState = {
  traversal: selectedRecord.traversal,
  keymap: selectedRecord.keymap,
  combine: selectedRecord.combine,
  step: 0,
  playing: true,
  speed: 180,
};

// ---------- Library ----------

function getTrackTheme(index) {
  return ["light", "dark", "plum"][(index - 1) % 3];
}

function initLibrary(player) {
  // If the library grid was pre-rendered by the build script, just wire handlers.
  // Otherwise fall back to creating the DOM.
  const grid = $("#library-grid");
  if (!grid.hasChildNodes()) {
    renderLibrary(grid);
  }
  grid.querySelectorAll(".library-card").forEach((button) => {
    const record = records.find((r) => r.id === button.dataset.recordId);
    if (!record) return;
    button.addEventListener("click", () => selectRecord(player, record, { autoplay: false, scroll: true }));
  });
}

function renderLibrary(grid) {
  grid.replaceChildren();
  records.forEach((record) => {
    const button = document.createElement("button");
    button.className = "library-card";
    button.type = "button";
    button.dataset.recordId = record.id;
    button.dataset.active = String(record.id === selectedRecord.id);
    button.innerHTML = `
      <img src="${record.thumbnailUrl}" alt="${escapeHTML(record.description)}" loading="lazy" width="800" height="800" />
      <span class="card-meta">
        <span class="type-library-title">${record.index.toString().padStart(2, "0")} / ${escapeHTML(record.title)}</span>
        <span class="type-library-meta">${escapeHTML(record.song)} / ${escapeHTML(record.combine)} / ${escapeHTML(record.traversal)}</span>
      </span>
    `;
    grid.append(button);
  });
}

// ---------- Track list ----------

function initTrackList(player) {
  // If the track list was pre-rendered by the build script, just wire handlers.
  // Otherwise fall back to creating the DOM.
  const list = $("#track-list");
  if (!list.hasChildNodes()) {
    renderTrackList(list);
  }
  list.querySelectorAll(".track-spotlight").forEach((article) => {
    const record = records.find((r) => r.id === article.dataset.recordId);
    if (!record) return;
    article.querySelector(".spotlight-frame")
      ?.addEventListener("click", () => prepareAndPlaySpotlight(player, record, article));
  });
}

function renderTrackList(list) {
  list.replaceChildren();
  records.forEach((record) => {
    const article = document.createElement("article");
    article.className = "track-spotlight";
    article.id = recordDetailId(record);
    article.dataset.recordId = record.id;
    article.dataset.theme = getTrackTheme(record.index);
    article.dataset.active = String(record.id === selectedRecord.id);
    article.innerHTML = spotlightHTML(record);
    list.append(article);
  });
}

function spotlightHTML(record) {
  return `
    <img class="spotlight-section-bg" src="${record.thumbnailUrl}" alt="" loading="lazy" />
    <div class="spotlight-inner">
      <div class="spotlight-media">
        <img class="spotlight-bg" src="${record.thumbnailUrl}" alt="" loading="lazy" />
        <button class="spotlight-frame" type="button" aria-label="Play ${escapeHTML(record.artist)} — ${escapeHTML(record.song)}">
          <img class="spotlight-image" src="${record.thumbnailUrl}" data-full-src="${record.imageUrl}" alt="${escapeHTML(record.description)}" loading="lazy" />
          <canvas class="spotlight-recon" aria-hidden="true"></canvas>
          <canvas class="spotlight-overlay" aria-hidden="true"></canvas>
        </button>
      </div>
      <div class="spotlight-content">
        <div class="spotlight-copy">
          <p class="type-meta-label">${record.index.toString().padStart(2, "0")}</p>
          <h2 class="type-display-feature">${escapeHTML(record.artist)}</h2>
          <div class="spotlight-lockup type-body-editorial">
            <p class="spotlight-song">${songTitle(record)}</p>
            <p class="spotlight-location-date">${escapeHTML(locationDateLabel(record))}</p>
          </div>
          <p class="spotlight-details type-body-compact">${detailsWithSource(record)}</p>
        </div>
        <div class="spotlight-controls">
          <dl class="spotlight-params">
            <div><dt>Combine</dt><dd>${escapeHTML(channelPlanSummary(record))}</dd></div>
            <div><dt>Traversal</dt><dd>${escapeHTML(record.traversal)}</dd></div>
            <div><dt>Keymap</dt><dd>${escapeHTML(record.keymap)}</dd></div>
            <div><dt>Border</dt><dd>${escapeHTML(borderLabel(record))}</dd></div>
          </dl>
        </div>
      </div>
    </div>
  `;
}

// ---------- Playback ----------

async function ensureHighFidelityImage(section, record) {
  const image = section.querySelector(".spotlight-image");
  if (!image || image.dataset.loadedFull === "true") return section.fullImagePromise || Promise.resolve();
  if (!section.fullImagePromise) {
    section.fullImagePromise = loadImage(record.imageUrl).then(() => {
      image.src = record.imageUrl;
      image.dataset.loadedFull = "true";
    });
  }
  return section.fullImagePromise;
}

async function prepareAndPlaySpotlight(player, record, section) {
  // Toggle off if tapping the currently-playing record
  if (record.id === selectedRecord.id && player.playing) {
    player.pause();
    return;
  }

  const requestId = ++playRequestId;
  player.load(record, false);
  section.dataset.loading = "true";

  try {
    const imagePromise = ensureHighFidelityImage(section, record);
    const audioPromise = player.prepare(record);
    await imagePromise;
    if (requestId !== playRequestId || selectedRecord.id !== record.id) return;
    await audioPromise;
    if (requestId !== playRequestId || selectedRecord.id !== record.id) return;
    player.play();
  } catch (error) {
    section.dataset.decodeError = error.message;
    console.error(error);
  } finally {
    if (requestId === playRequestId) section.dataset.loading = "false";
  }
}

function updateRecordSelection(progress = 0, playing = false) {
  $$(".library-card").forEach((card) => {
    card.dataset.active = String(card.dataset.recordId === selectedRecord.id);
  });
  $$(".track-spotlight").forEach((section) => {
    const active = section.dataset.recordId === selectedRecord.id;
    section.dataset.active = String(active);
    updateSpotlightReveal(section, active ? progress : 0, active && playing);
  });
}

async function getRevealState(host, record, frame) {
  if (host.revealState) return host.revealState;
  if (host.revealPromise) return host.revealPromise;
  host.revealPromise = createRevealState(record, frame)
    .then((state) => {
      host.revealState = state;
      return state;
    })
    .catch((error) => {
      host.dataset.decodeError = error.message;
      return null;
    });
  return host.revealPromise;
}

function updateSpotlightReveal(section, progress, playing) {
  const frame = section.querySelector(".spotlight-frame");
  const record = records.find((item) => item.id === section.dataset.recordId);
  if (!playing) {
    frame.dataset.revealing = "false";
    if (section.revealState) resetRevealState(section.revealState);
    return;
  }

  if (section.revealState) {
    frame.dataset.revealing = "true";
    revealAtProgress(section.revealState, progress);
    return;
  }

  frame.dataset.revealing = "false";
  getRevealState(section, record, frame).then((state) => {
    if (!state) return;
    frame.dataset.revealing = "true";
    revealAtProgress(state, progress);
  });
}

// ---------- Section background ----------

function initSectionBackground() {
  const shell = $(".site-shell");
  if (!shell || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const bg = getComputedStyle(entry.target).backgroundColor;
        document.documentElement.style.setProperty("--page-bg", bg);
      }
    },
    { root: shell, rootMargin: "-50% 0px -50% 0px", threshold: 0 },
  );

  const sections = $$(
    ".hero-section, .concept-band, .library-section, .track-spotlight, " +
    ".pattern-overview-section, .interactive-section",
  );
  sections.forEach((el) => observer.observe(el));
}

// ---------- Pattern overview ----------

function renderPatternOverview() {
  const traversalGrid = $("#traversal-overview-grid");
  const keymapGrid = $("#keymap-overview-grid");

  if (traversalGrid && !traversalGrid.hasChildNodes()) {
    traversalInfo.forEach(([name, description], index) => {
      const card = document.createElement("article");
      card.className = "pattern-card";
      card.innerHTML = `
        <canvas width="112" height="112" data-pattern-kind="traversal" data-pattern-name="${escapeHTML(name)}" data-pattern-offset="${index * 333}" aria-label="${escapeHTML(name)} traversal pattern"></canvas>
        <div class="pattern-card-copy">
          <h4>${escapeHTML(name)}</h4>
          <p>${escapeHTML(description)}</p>
        </div>
      `;
      traversalGrid.append(card);
    });
  }

  if (keymapGrid && !keymapGrid.hasChildNodes()) {
    keymapInfo.forEach(([name, description], index) => {
      const card = document.createElement("article");
      card.className = "pattern-card";
      card.innerHTML = `
        <canvas width="112" height="112" data-pattern-kind="keymap" data-pattern-name="${escapeHTML(name)}" data-pattern-offset="${index * 260}" aria-label="${escapeHTML(name)} keymap pattern"></canvas>
        <div class="pattern-card-copy">
          <h4>${escapeHTML(name)}</h4>
          <p>${escapeHTML(description)}</p>
        </div>
      `;
      keymapGrid.append(card);
    });
  }
}

// ---------- Combine equations ----------

function renderCombineOptions() {
  const select = $("#combine-select");
  if (select) {
    select.replaceChildren();
    combineInfo.forEach(([name]) => {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === selectedCombine;
      select.append(option);
    });
  }
  updateCombineSelectDesc();
}

function updateCombineSelectDesc() {
  const desc = $("#combine-select-desc");
  if (!desc) return;
  const info = combineInfo.find(([name]) => name === selectedCombine);
  desc.textContent = info ? info[1] : "";
}

function pixelSquare(label, value, light = true) {
  const shade = light ? value : 255 - value;
  const color = shade > 127 ? "#0a0a0a" : "#ffffff";
  return `
    <div class="pixel-square" style="background: rgb(${shade}, ${shade}, ${shade}); color: ${color}">
      <span class="type-meta-label">${label}</span>
      <span>${hex(value)}</span>
      <span>${bits(value)}</span>
    </div>
  `;
}

function renderEquation() {
  const data = Number($("#data-byte").value);
  const key = Number($("#key-byte").value);
  const op = operations[selectedCombine];
  const encoded = op.encode(data, key);
  const decoded = op.decode(encoded, key);
  $("#data-output").textContent = String(data);
  $("#key-output").textContent = String(key);
  $("#pixel-transform").innerHTML = [
    pixelSquare("data", data),
    pixelSquare("key", key),
    pixelSquare("stored", encoded, false),
    pixelSquare("decoded", decoded),
  ].join("");
  $("#combine-formula").textContent = op.formula;
  $("#combine-calculation").textContent = [
    `data    ${hex(data)} = ${data} = ${bits(data)}`,
    `key     ${hex(key)} = ${key} = ${bits(key)}`,
    `stored  ${hex(encoded)} = ${encoded} = ${bits(encoded)}`,
    `decoded ${hex(decoded)} = ${decoded} = ${bits(decoded)}`,
    op.lossless && decoded === data ? "round-trip: exact" : `delta: ${Math.abs(decoded - data)}`,
  ].join("\n");
}

// ---------- Explorer ----------

function populateSelect(selector, options, value) {
  const select = $(selector);
  if (!select) return;
  select.replaceChildren();
  options.forEach(([name]) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    option.selected = name === value;
    select.append(option);
  });
}

function renderExplorerOptions() {
  populateSelect("#traversal-select", traversalInfo, explorerState.traversal);
  populateSelect("#keymap-select", keymapInfo, explorerState.keymap);
}

function tickExplorer() {
  const readout = drawExplorer($("#explorer-canvas"), explorerState);
  $("#pixel-readout").innerHTML = `
    <dt>step</dt><dd>${readout.step + 1} / ${readout.total}</dd>
    <dt>data</dt><dd>(${readout.data[0]}, ${readout.data[1]}) / ${hex(readout.audio)}</dd>
    <dt>key</dt><dd>(${readout.key[0]}, ${readout.key[1]}) / ${hex(readout.keyValue)}</dd>
  `;
}

function scheduleExplorer() {
  tickExplorer();
  if (explorerState.playing) {
    explorerState.step += 1;
  }
  window.setTimeout(scheduleExplorer, explorerState.speed);
}

// ---------- Drawing ----------

function drawPatternOverview() {
  document.querySelectorAll("canvas[data-pattern-kind]").forEach((canvas) => {
    const offset = Number(canvas.dataset.patternOffset || 0);
    if (canvas.dataset.patternKind === "keymap") {
      drawMiniKeymap(canvas, canvas.dataset.patternName, offset);
    } else {
      drawMiniTraversal(canvas, canvas.dataset.patternName, offset);
    }
  });
}

function animatePatternOverview() {
  drawPatternOverview();
  window.requestAnimationFrame(animatePatternOverview);
}

// ---------- Player init ----------

function initPlayer() {
  const player = new Player({
    onSelect(record) {
      selectedRecord = record;
      selectedCombine = record.combine;
      explorerState = {
        ...explorerState,
        traversal: record.traversal,
        keymap: record.keymap,
        combine: record.combine,
        step: 0,
      };
      updateRecordSelection(0, player.playing);
      renderCombineOptions();
      renderEquation();
      renderExplorerOptions();
    },
    onProgress(progress, playing) {
      updateRecordSelection(progress, playing);
    },
  });

  player.load(selectedRecord, false);
  return player;
}

// ---------- Header ----------

function initHeader(textureUrls) {
  const header = new WebglHeader($("#hero-canvas"), textureUrls);
  if (header.start()) {
    document.documentElement.classList.add("has-webgl-header");
    return;
  }

  // WebGL unavailable — fall back to an animated sprite layer of thumbnails.
  // Static tiles (CSS-only) stay hidden; only reveal them if sprites also fail.
  document.documentElement.classList.add("has-media-assets");
  const layer = document.createElement("div");
  layer.className = "hero-sprite-layer";
  let loaded = 0;
  textureUrls.slice(0, 8).forEach((src, index) => {
    const image = document.createElement("img");
    image.src = src;
    image.alt = "";
    image.style.setProperty("--sprite-index", index);
    image.style.setProperty("--sprite-x", `${(index % 4) * 24}%`);
    image.style.setProperty("--sprite-y", `${8 + index * 11}%`);
    image.onload = () => { loaded += 1; };
    layer.append(image);
  });
  $(".hero-section").insertBefore(layer, $(".hero-vignette"));

  // Last resort: if no images loaded after a delay, show the static tiles.
  window.setTimeout(() => {
    if (loaded === 0) document.documentElement.classList.add("has-static-tiles");
  }, 3000);
}

// ---------- Init ----------

function init() {
  explorerState = {
    ...explorerState,
    traversal: selectedRecord.traversal,
    keymap: selectedRecord.keymap,
    combine: selectedRecord.combine,
  };

  const textureUrls = records.map((record) => record.thumbnailUrl);
  const player = initPlayer();

  initLibrary(player);
  renderPatternOverview();
  initTrackList(player);
  renderCombineOptions();
  renderEquation();
  renderExplorerOptions();
  initHeader(textureUrls);
  animatePatternOverview();
  initSectionBackground();

  $("#combine-select")?.addEventListener("change", (e) => {
    selectedCombine = e.target.value;
    renderCombineOptions();
    renderEquation();
  });
  $("#data-byte").addEventListener("input", renderEquation);
  $("#key-byte").addEventListener("input", renderEquation);
  $("#explorer-speed").addEventListener("input", (event) => {
    explorerState.speed = Number(event.target.value);
    $("#speed-output").textContent = `${explorerState.speed}ms`;
  });
  $("#explorer-toggle").addEventListener("click", () => {
    explorerState.playing = !explorerState.playing;
    $("#explorer-toggle").textContent = explorerState.playing ? "Pause" : "Play";
  });
  $("#traversal-select")?.addEventListener("change", (e) => {
    explorerState.traversal = e.target.value;
    explorerState.step = 0;
  });
  $("#keymap-select")?.addEventListener("change", (e) => {
    explorerState.keymap = e.target.value;
    explorerState.step = 0;
  });
  scheduleExplorer();
}

init();
