'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GLUE_REQUIRE = /require\('(?:\.\.\/)+src\/([a-z0-9-]+)'\)/g;
const SRC_REQUIRE = /require\('\.\/([a-z0-9-]+)'\)/g;
const CONFIG_REFERENCE = /\bCONFIG\.([A-Z0-9_]+)/g;

function collectModules(entryNames, srcDir) {
  const sources = new Map();
  const pending = [...entryNames];
  while (pending.length > 0) {
    const name = pending.shift();
    if (sources.has(name)) continue;
    const file = path.join(srcDir, `${name}.js`);
    if (!fs.existsSync(file)) throw new Error(`Unknown src module "${name}"`);
    const source = fs.readFileSync(file, 'utf8');
    sources.set(name, source);
    for (const match of source.matchAll(SRC_REQUIRE)) pending.push(match[1]);
  }
  return sources;
}

// Produces the JavaScript for one n8n Code node: the src/ modules it needs (each wrapped in a
// CommonJS-style factory), the settings it references as a frozen CONFIG object, then the
// glue code with its src requires pointed at the bundled modules.
function bundleCode(gluePath, { srcDir, settings, label }) {
  const glue = fs.readFileSync(gluePath, 'utf8');
  const entryNames = [...glue.matchAll(GLUE_REQUIRE)].map((match) => match[1]);
  const modules = collectModules(entryNames, srcDir);

  const configKeys = [...new Set([...glue.matchAll(CONFIG_REFERENCE)].map((match) => match[1]))];
  for (const key of configKeys) {
    if (!(key in settings)) throw new Error(`${label} uses unknown setting CONFIG.${key}`);
  }

  const parts = [
    `// Built by scripts/build.js from ${label} and src/. Edit those files, not this node.`,
  ];
  if (configKeys.length > 0) {
    const config = Object.fromEntries(configKeys.sort().map((key) => [key, settings[key]]));
    parts.push(`const CONFIG = Object.freeze(${JSON.stringify(config, null, 2)});`);
  }
  if (modules.size > 0) {
    const factories = [...modules.entries()]
      .map(
        ([name, source]) =>
          `  '${name}': function (module, exports, require) {\n${source.trim()}\n  },`,
      )
      .join('\n');
    parts.push(
      `const __modules = {\n${factories}\n};`,
      [
        'const __cache = {};',
        'function __require(name) {',
        "  const key = name.replace(/^\\.\\//, '');",
        '  if (!__cache[key]) {',
        '    const module = { exports: {} };',
        '    __cache[key] = module;',
        '    __modules[key](module, module.exports, __require);',
        '  }',
        '  return __cache[key].exports;',
        '}',
      ].join('\n'),
    );
  }
  parts.push(glue.replace(GLUE_REQUIRE, (_match, name) => `__require('${name}')`).trim());
  return `${parts.join('\n\n')}\n`;
}

module.exports = { bundleCode };
