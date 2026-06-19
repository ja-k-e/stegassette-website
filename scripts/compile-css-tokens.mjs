#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const REF_RE = /^\{([^}]+)\}$/;

function usage() {
  return [
    "Usage:",
    "  node scripts/compile-css-tokens.mjs <tokens.json> [--out <theme.css>]",
    "",
    "Compiles theme tokens into CSS custom properties and typography utility classes.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const input = args.shift();
  if (!input || input === "-h" || input === "--help") return { help: true };
  let out = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === "--out") {
      out = args.shift();
      if (!out) throw new Error("--out requires a path");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { input, out };
}

function isTokenNode(value) {
  return Boolean(value && typeof value === "object" && "$type" in value && "$value" in value);
}

function flattenTokens(node, prefix = [], out = []) {
  if (!node || typeof node !== "object") return out;
  if (isTokenNode(node)) {
    out.push({ path: prefix.join("."), type: node.$type, value: node.$value });
    return out;
  }
  for (const [key, value] of Object.entries(node)) flattenTokens(value, [...prefix, key], out);
  return out;
}

function tokenRef(value) {
  if (typeof value !== "string") return null;
  const match = value.match(REF_RE);
  return match ? match[1] : null;
}

function cssName(name) {
  return `--${name.replace(/[./\s]+/g, "-").toLowerCase()}`;
}

function className(name) {
  return name.replace(/[./\s]+/g, "-").toLowerCase();
}

function trimNumber(value) {
  return Number(value.toFixed(6)).toString();
}

function pxToRem(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (!match) return null;
  return `${trimNumber(Number(match[1]) / 16)}rem`;
}

function cssString(value) {
  return JSON.stringify(String(value));
}

function cssTokenValue(value, tokenType = null) {
  const ref = tokenRef(value);
  if (ref) return `var(${cssName(ref)})`;
  const rem = pxToRem(value);
  if (rem) return rem;
  if (tokenType === "fontFamily") return cssString(value);
  return String(value);
}

function cssFontStyle(value) {
  const ref = tokenRef(value);
  if (ref) return `var(${cssName(ref)})`;
  if (!value) return null;
  return String(value).toLowerCase().includes("italic") ? "italic" : "normal";
}

function deepMerge(base, override) {
  if (!override || typeof override !== "object") return base;
  const merged = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      merged[key] = deepMerge(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function containerQuery(system, ruleName) {
  const minWidth = system.rules?.[ruleName]?.container?.minWidth;
  return minWidth ? `@container (min-width: ${pxToRem(minWidth) || minWidth})` : null;
}

function typographyDeclarations(value) {
  const font = value.font || {};
  const text = value.text || {};
  const declarations = [
    ["font-family", cssTokenValue(font.family)],
    ["font-style", cssFontStyle(font.style)],
    ["font-weight", cssTokenValue(font.weight)],
    ["font-size", cssTokenValue(text.size)],
    ["line-height", cssTokenValue(text.lineHeight)],
    ["letter-spacing", cssTokenValue(text.tracking || "{size.tracking.none}")],
  ];
  if (text.transform) declarations.push(["text-transform", text.transform]);
  if (text.wrap) declarations.push(["text-wrap", text.wrap]);
  return declarations.filter(([, value]) => value && value !== "undefined");
}

function renderRule(selector, declarations, indent = "") {
  const body = declarations.map(([key, value]) => `${indent}  ${key}: ${value};`).join("\n");
  return `${indent}${selector} {\n${body}\n${indent}}`;
}

export function compileCss(system) {
  const tokens = flattenTokens(system.tokens || {});
  const lines = [
    "/* Generated from tokens/stegassette-theme.tokens.json. Do not edit by hand. */",
    "",
    ":root {",
  ];
  for (const token of tokens) {
    lines.push(`  ${cssName(token.path)}: ${cssTokenValue(token.value, token.type)};`);
  }
  lines.push("}", "");
  lines.push("/* Apply this to an ancestor of responsive type utilities. */");
  lines.push(":where(.stegassette-container, [data-stegassette-container]) {");
  lines.push("  container-type: inline-size;");
  lines.push("}", "");

  for (const [name, hypertoken] of Object.entries(system.hypertokens || {})) {
    if (hypertoken.$type !== "typography") continue;
    const selector = `.${className(name)}`;
    const base = hypertoken.$value || {};
    lines.push(renderRule(selector, typographyDeclarations(base)), "");

    const rules = hypertoken.$extensions?.rules || {};
    for (const [ruleName, override] of Object.entries(rules)) {
      const query = containerQuery(system, ruleName);
      if (!query) continue;
      const merged = deepMerge(base, override);
      lines.push(`${query} {`);
      lines.push(renderRule(selector, typographyDeclarations(merged), "  "));
      lines.push("}", "");
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const inputPath = path.resolve(args.input);
const system = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const css = compileCss(system);

if (args.out) {
  const outPath = path.resolve(args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, css);
} else {
  process.stdout.write(css);
}
