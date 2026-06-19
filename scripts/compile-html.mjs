/**
 * Pre-renders the library grid and track list into index.html so content is
 * visible without JavaScript. Run whenever live.jobs.json or data.js changes.
 *
 *   node scripts/compile-html.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataPath = join(root, "public", "scripts", "data.js");
const htmlPath = join(root, "public", "index.html");

// ---------------------------------------------------------------------------
// Load records from data.js by extracting the JSON-compatible records array.
// data.js is a plain ES module that exports `records` as a JS array literal
// with only JSON-safe values, so we can read it as text and eval the export.
// ---------------------------------------------------------------------------

const dataSource = readFileSync(dataPath, "utf8");

// Extract everything between `export const records = [` … `];`
const match = dataSource.match(/export const records\s*=\s*(\[[\s\S]*?\n\];)/m);
if (!match) throw new Error("Could not parse records from data.js");

// eslint-disable-next-line no-eval
const records = eval(match[1]);

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function getTrackTheme(index) {
  return ["light", "dark", "plum"][(index - 1) % 3];
}

function recordDetailId(record) {
  return `track-${record.index.toString().padStart(2, "0")}`;
}

function locationDateLabel(record) {
  const parts = [record.location, record.date].filter(Boolean);
  return parts.length ? parts.join(", ") : "unknown";
}

function borderLabel(record) {
  return String(record.border ?? "").replace(/px$/i, "");
}

const rgbChannels = ["r", "g", "b"];

function channelPlanSummary(record) {
  let slots;
  if (Array.isArray(record.channels) && record.channels.length) {
    slots = record.channels
      .map((slot) => ({
        ch: String(slot.ch ?? slot.channel ?? "").toLowerCase(),
        combine: slot.combine || record.combine,
      }))
      .filter((slot) => rgbChannels.includes(slot.ch));
  } else {
    slots = rgbChannels.map((ch) => ({ ch, combine: record.combine }));
  }
  const byChannel = new Map(slots.map((slot) => [slot.ch, slot.combine]));
  const values = rgbChannels.map((ch) => byChannel.get(ch) || "passthrough");
  if (values.every((v) => v === values[0])) return `RGB: ${values[0]}`;
  return rgbChannels.map((ch, i) => `${ch.toUpperCase()}:${values[i]}`).join(" · ");
}

function linkifyDomains(value) {
  return String(value ?? "").replace(/https?:\/\/[^\s)]+/g, (match) => {
    const trailing = match.match(/[.,;:!?]+$/)?.[0] ?? "";
    const href = trailing ? match.slice(0, -trailing.length) : match;
    let label = href;
    try { label = new URL(href).hostname.replace(/^www\./, ""); } catch { label = href; }
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

// ---------------------------------------------------------------------------
// Generate HTML fragments
// ---------------------------------------------------------------------------

function renderLibraryGrid(records) {
  return records.map((record) => `
          <button class="library-card" type="button" data-record-id="${escapeHTML(record.id)}" data-active="false">
            <img src="${escapeHTML(record.thumbnailUrl)}" alt="${escapeHTML(record.description)}" loading="lazy" width="800" height="800" />
            <span class="card-meta">
              <span class="type-library-title">${escapeHTML(record.artist)}</span>
            </span>
          </button>`).join("\n");
}

function renderSpotlight(record) {
  const theme = getTrackTheme(record.index);
  return `
        <article class="track-spotlight" id="${recordDetailId(record)}" data-record-id="${escapeHTML(record.id)}" data-theme="${theme}" data-active="false">
          <img class="spotlight-section-bg" src="${escapeHTML(record.thumbnailUrl)}" alt="" loading="lazy" />
          <div class="spotlight-inner">
            <div class="spotlight-media">
              <img class="spotlight-bg" src="${escapeHTML(record.thumbnailUrl)}" alt="" loading="lazy" />
              <button class="spotlight-frame" type="button" aria-label="Play ${escapeHTML(record.artist)} — ${escapeHTML(record.song)}">
                <img class="spotlight-image" src="${escapeHTML(record.thumbnailUrl)}" data-full-src="${escapeHTML(record.imageUrl)}" alt="${escapeHTML(record.description)}" loading="lazy" />
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
        </article>`;
}

function renderTrackList(records) {
  return records.map(renderSpotlight).join("\n");
}

// ---------------------------------------------------------------------------
// Inject into index.html between comment markers
// ---------------------------------------------------------------------------

function inject(html, marker, content) {
  const start = `<!-- ${marker}_START -->`;
  const end = `<!-- ${marker}_END -->`;
  const before = html.indexOf(start);
  const after = html.indexOf(end);
  if (before === -1 || after === -1) throw new Error(`Markers not found for ${marker}`);
  return html.slice(0, before + start.length) + content + html.slice(after);
}

let html = readFileSync(htmlPath, "utf8");
html = inject(html, "LIBRARY_GRID", renderLibraryGrid(records));
html = inject(html, "TRACK_LIST", renderTrackList(records));
writeFileSync(htmlPath, html, "utf8");

console.log(`✓ Pre-rendered ${records.length} records into index.html`);
