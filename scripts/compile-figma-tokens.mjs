#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const REF_RE = /^\{([^}]+)\}$/;

function usage() {
  return [
    "Usage:",
    "  node scripts/compile-figma-tokens.mjs <tokens.json> [--out <figma-script.js>]",
    "",
    "Compiles the token JSON into a deterministic Figma Plugin API script.",
    "If --out is omitted, the generated script is written to stdout.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = [...argv];
  const input = args.shift();
  if (!input || input === "-h" || input === "--help") {
    return { help: true };
  }
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
    out.push({
      path: prefix.join("."),
      type: node.$type,
      value: node.$value,
      description: node.description,
    });
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    flattenTokens(value, [...prefix, key], out);
  }
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

function variableName(tokenPath) {
  return tokenPath.replace(/\./g, "/");
}

function collectionName(systemName, tokenPath) {
  const root = tokenPath.split(".")[0];
  const label = {
    color: "Color",
    font: "Font",
    size: "Size",
  }[root] || "Tokens";
  return `${systemName} / ${label}`;
}

function variableType(token) {
  if (token.type === "color") return "COLOR";
  if (token.type === "fontFamily") return "STRING";
  if (token.type === "fontStyle") return "STRING";
  if (token.type === "dimension") return "FLOAT";
  if (token.type === "fontWeight") return "FLOAT";
  if (token.type === "number") return "FLOAT";
  if (token.type === "boolean") return "BOOLEAN";
  return "STRING";
}

function variableScopes(tokenPath, tokenType) {
  if (tokenPath.startsWith("color.text.")) return ["TEXT_FILL"];
  if (tokenPath.startsWith("color.background.")) return ["FRAME_FILL", "SHAPE_FILL"];
  if (tokenPath.startsWith("color.border.")) return ["STROKE_COLOR"];
  if (tokenPath.startsWith("color.")) return ["ALL_FILLS"];
  if (tokenPath.startsWith("font.family.")) return ["FONT_FAMILY"];
  if (tokenPath.startsWith("font.style.")) return ["FONT_STYLE"];
  if (tokenPath.startsWith("font.weight.")) return ["FONT_WEIGHT"];
  if (tokenPath.startsWith("size.font.")) return ["FONT_SIZE"];
  if (tokenPath.startsWith("size.line.")) return ["LINE_HEIGHT"];
  if (tokenPath.startsWith("size.tracking.")) return ["LETTER_SPACING"];
  if (tokenPath.startsWith("size.space.")) return ["GAP"];
  if (tokenPath.startsWith("size.radius.")) return ["CORNER_RADIUS"];
  if (tokenPath.startsWith("size.layout.")) return ["WIDTH_HEIGHT"];
  if (tokenType === "dimension" || tokenType === "number" || tokenType === "fontWeight") return [];
  return [];
}

function hexToFigmaColor(value) {
  const normalized = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Unsupported color value: ${value}`);
  }
  const n = Number.parseInt(normalized, 16);
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255,
    a: 1,
  };
}

function dimensionToNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") throw new Error(`Unsupported dimension value: ${JSON.stringify(value)}`);
  const match = value.match(/^(-?\d+(?:\.\d+)?)px$/);
  if (!match) throw new Error(`Only px dimensions are supported for Figma variables: ${value}`);
  return Number(match[1]);
}

function compiledLiteralValue(token) {
  if (token.type === "color") return hexToFigmaColor(token.value);
  if (token.type === "fontFamily") return String(token.value);
  if (token.type === "fontStyle") return String(token.value);
  if (token.type === "dimension") return dimensionToNumber(token.value);
  if (token.type === "fontWeight") return Number(token.value);
  if (token.type === "number") {
    const n = Number(token.value);
    return token.path.startsWith("size.line.") ? n * 100 : n;
  }
  if (token.type === "boolean") return Boolean(token.value);
  return String(token.value);
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

function resolveTokenValue(refOrValue, tokensByPath) {
  const ref = tokenRef(refOrValue);
  if (!ref) return { value: refOrValue, ref: null, variableName: null };
  const token = tokensByPath.get(ref);
  if (!token) throw new Error(`Unknown token reference: ${ref}`);
  return { value: token.value, ref, variableName: variableName(ref) };
}

function resolvedNumber(refOrValue, tokensByPath) {
  const resolved = resolveTokenValue(refOrValue, tokensByPath);
  if (typeof resolved.value === "number") return { ...resolved, number: resolved.value };
  return { ...resolved, number: dimensionToNumber(resolved.value) };
}

function textCaseFor(transform) {
  if (transform === "uppercase") return "UPPER";
  if (transform === "lowercase") return "LOWER";
  if (transform === "capitalize") return "TITLE";
  return "ORIGINAL";
}

function titleWords(value) {
  return String(value)
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function figmaWeightName(weight) {
  if (typeof weight === "string" && !/^-?\d+(?:\.\d+)?$/.test(weight.trim())) {
    const normalized = titleWords(weight);
    if (normalized.includes("Italic")) return normalized.replace(/\s*Italic\b/g, "").trim() || "Regular";
    return normalized;
  }
  return Number(weight) >= 700 ? "Bold" : "Regular";
}

function fontStyleFromTypography(weight, explicitStyle) {
  if (explicitStyle) {
    const style = titleWords(explicitStyle);
    if (style !== "Italic") return style;
    const base = figmaWeightName(weight);
    return base === "Regular" ? "Book Italic" : `${base} Italic`;
  }
  if (typeof weight === "string" && weight.toLowerCase().includes("italic")) {
    return titleWords(weight);
  }
  return figmaWeightName(weight);
}

function compileVariables(tokens, systemName) {
  return tokens.map((token) => {
    const alias = tokenRef(token.value);
    const name = variableName(token.path);
    return {
      tokenPath: token.path,
      name,
      collection: collectionName(systemName, token.path),
      type: variableType(token),
      scopes: variableScopes(token.path, token.type),
      codeSyntax: cssName(name),
      alias: alias ? variableName(alias) : null,
      value: alias ? null : compiledLiteralValue(token),
    };
  });
}

function compileTextStyles(system, tokensByPath) {
  const textStyles = [];
  for (const [name, hypertoken] of Object.entries(system.hypertokens || {})) {
    if (hypertoken.$type !== "typography") continue;
    const base = hypertoken.$value || {};
    const variants = [{ rule: "default", suffix: "", value: base }];
    const rules = hypertoken.$extensions?.rules || {};
    for (const [ruleName, override] of Object.entries(rules)) {
      variants.push({
        rule: ruleName,
        suffix: `@${ruleName}`,
        value: deepMerge(base, override),
      });
    }
    for (const variant of variants) {
      const font = variant.value.font || {};
      const text = variant.value.text || {};
      const family = resolveTokenValue(font.family, tokensByPath);
      const weight = resolveTokenValue(font.weight, tokensByPath);
      const style = font.style ? resolveTokenValue(font.style, tokensByPath) : null;
      const size = resolvedNumber(text.size, tokensByPath);
      const line = text.lineHeight ? resolveTokenValue(text.lineHeight, tokensByPath) : null;
      const tracking = text.tracking ? resolvedNumber(text.tracking, tokensByPath) : null;
      const rawLineValue = line ? Number(line.value) : null;
      const lineHeight = line
        ? { unit: "PERCENT", value: rawLineValue <= 10 ? rawLineValue * 100 : rawLineValue }
        : { unit: "AUTO" };
      const styleName = `${name.replace(/\./g, "/")}${variant.suffix}`;
      textStyles.push({
        hypertoken: name,
        rule: variant.rule,
        name: styleName,
        fontFamily: String(family.value),
        fontStyle: fontStyleFromTypography(weight.value, style ? style.value : null),
        fontSize: size.number,
        lineHeight,
        letterSpacing: tracking ? { unit: "PIXELS", value: tracking.number } : { unit: "PIXELS", value: 0 },
        textCase: textCaseFor(text.transform),
        bindings: {
          fontFamily: family.variableName,
          fontStyle: style ? style.variableName : null,
          fontWeight: weight.variableName,
          fontSize: size.variableName,
          lineHeight: line && tokensByPath.get(line.ref)?.type === "dimension" ? line.variableName : null,
          letterSpacing: tracking ? tracking.variableName : null,
        },
      });
    }
  }
  return textStyles;
}

export function compileFigmaTokenScript(system) {
  const systemName = system.meta?.name || "Theme";
  const tokens = flattenTokens(system.tokens || {});
  const tokensByPath = new Map(tokens.map((token) => [token.path, token]));
  const compiled = {
    meta: system.meta || {},
    variables: compileVariables(tokens, systemName),
    textStyles: compileTextStyles(system, tokensByPath),
  };

  return `const COMPILED = ${JSON.stringify(compiled, null, 2)}

function findModeId(collection) {
  const existingDefault = collection.modes.find((mode) => mode.name === 'Default')
  return existingDefault ? existingDefault.modeId : collection.modes[0].modeId
}

function sanitizeDescription(value) {
  return String(value || '').slice(0, 1000)
}

async function upsertCollections(defs) {
  const existing = await figma.variables.getLocalVariableCollectionsAsync()
  const byName = new Map(existing.map((collection) => [collection.name, collection]))
  const result = new Map()
  const created = []
  for (const name of [...new Set(defs.map((def) => def.collection))]) {
    let collection = byName.get(name)
    if (!collection) {
      collection = figma.variables.createVariableCollection(name)
      collection.renameMode(collection.modes[0].modeId, 'Default')
      created.push(name)
    }
    result.set(name, { collection, modeId: findModeId(collection) })
  }
  return { result, created }
}

async function upsertVariables(defs, collections) {
  const localVariables = await figma.variables.getLocalVariablesAsync()
  const byKey = new Map(localVariables.map((variable) => [variable.variableCollectionId + '::' + variable.name, variable]))
  const byName = new Map()
  const created = []
  const updated = []
  const errors = []

  for (const def of defs) {
    const collectionInfo = collections.get(def.collection)
    if (!collectionInfo) {
      errors.push('Missing collection for ' + def.name)
      continue
    }
    const key = collectionInfo.collection.id + '::' + def.name
    let variable = byKey.get(key)
    if (!variable) {
      variable = figma.variables.createVariable(def.name, collectionInfo.collection, def.type)
      byKey.set(key, variable)
      created.push(def.name)
    } else {
      updated.push(def.name)
    }
    variable.scopes = def.scopes
    variable.setVariableCodeSyntax('WEB', 'var(' + def.codeSyntax + ')')
    if (!def.alias) {
      variable.setValueForMode(collectionInfo.modeId, def.value)
    }
    byName.set(def.name, { variable, collectionInfo })
  }

  for (const def of defs) {
    if (!def.alias) continue
    const source = byName.get(def.name)
    const target = byName.get(def.alias)
    if (!source || !target) {
      errors.push('Missing alias target for ' + def.name + ' -> ' + def.alias)
      continue
    }
    source.variable.setValueForMode(source.collectionInfo.modeId, {
      type: 'VARIABLE_ALIAS',
      id: target.variable.id,
    })
  }

  return { byName, created, updated, errors }
}

function fontStyleCandidates(fonts, family, desiredStyle) {
  const styles = fonts
    .filter((font) => font.fontName.family === family)
    .map((font) => font.fontName.style)
  if (styles.includes(desiredStyle)) return desiredStyle
  if (desiredStyle.includes('Italic')) {
    const nonItalic = desiredStyle.replace(/\\s*Italic\\b/g, '').trim()
    if (styles.includes('Italic')) return 'Italic'
    if (styles.includes('Regular Italic')) return 'Regular Italic'
    if (styles.includes('Book Italic')) return 'Book Italic'
    if (styles.includes('Medium Italic')) return 'Medium Italic'
    if (styles.includes('Bold Italic')) return 'Bold Italic'
    if (nonItalic && styles.includes(nonItalic)) return nonItalic
  }
  if (styles.includes('Regular')) return 'Regular'
  if (styles.includes('Book')) return 'Book'
  if (styles.includes('Medium')) return 'Medium'
  return styles[0] || desiredStyle
}

async function upsertTextStyles(defs, variablesByName) {
  const existing = await figma.getLocalTextStylesAsync()
  const byName = new Map(existing.map((style) => [style.name, style]))
  const fonts = await figma.listAvailableFontsAsync()
  const created = []
  const updated = []
  const bound = []
  const errors = []

  for (const def of defs) {
    let style = byName.get(def.name)
    if (!style) {
      style = figma.createTextStyle()
      style.name = def.name
      byName.set(def.name, style)
      created.push(def.name)
    } else {
      updated.push(def.name)
    }

    const fontName = {
      family: def.fontFamily,
      style: fontStyleCandidates(fonts, def.fontFamily, def.fontStyle),
    }
    try {
      await figma.loadFontAsync(fontName)
      for (const field of ['fontFamily', 'fontWeight', 'fontSize', 'lineHeight', 'letterSpacing']) {
        if (!def.bindings[field]) {
          try {
            style.setBoundVariable(field, null)
          } catch (error) {
            errors.push('Could not clear binding ' + field + ' on ' + def.name + ': ' + error.message)
          }
        }
      }
      style.fontName = fontName
      style.fontSize = def.fontSize
      style.lineHeight = def.lineHeight
      style.letterSpacing = def.letterSpacing
      style.textCase = def.textCase
      style.description = sanitizeDescription(
        'Generated from ' + (COMPILED.meta.id || 'tokens') +
        '; hypertoken=' + def.hypertoken +
        '; rule=' + def.rule +
        '; bindings=' + JSON.stringify(def.bindings)
      )
      for (const [field, variableName] of Object.entries(def.bindings)) {
        if (!variableName) continue
        const target = variablesByName.get(variableName)
        if (!target) {
          errors.push('Missing variable for text style binding ' + def.name + ': ' + field + ' -> ' + variableName)
          continue
        }
        try {
          style.setBoundVariable(field, target.variable)
          bound.push(def.name + ':' + field)
        } catch (error) {
          errors.push('Could not bind ' + field + ' on ' + def.name + ': ' + error.message)
        }
      }
    } catch (error) {
      errors.push('Could not update text style ' + def.name + ': ' + error.message)
    }
  }

  return { created, updated, bound, errors }
}

const collections = await upsertCollections(COMPILED.variables)
const variables = await upsertVariables(COMPILED.variables, collections.result)
const textStyles = await upsertTextStyles(COMPILED.textStyles, variables.byName)

return {
  meta: COMPILED.meta,
  collectionsCreated: collections.created,
  variablesCreated: variables.created,
  variablesUpdated: variables.updated,
  variableErrors: variables.errors,
  textStylesCreated: textStyles.created,
  textStylesUpdated: textStyles.updated,
  textStyleBindings: textStyles.bound,
  textStyleErrors: textStyles.errors,
}
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const inputPath = path.resolve(args.input);
  const system = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const script = compileFigmaTokenScript(system);
  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, script);
  } else {
    process.stdout.write(script);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}
