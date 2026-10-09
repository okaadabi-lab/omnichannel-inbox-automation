'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { loadSettings } = require('./lib/config');
const { buildWorkflow } = require('./lib/build-workflow');
const sql = require('../src/sql');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(ROOT, 'workflows', 'src');

function buildAll(envPath) {
  const settings = loadSettings(envPath);
  return fs
    .readdirSync(TEMPLATE_DIR)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => {
      const template = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8'));
      const workflow = buildWorkflow(template, { settings, sql, rootDir: ROOT });
      return { file, text: `${JSON.stringify(workflow, null, 2)}\n` };
    });
}

function main() {
  const { values } = parseArgs({
    options: {
      env: { type: 'string', default: '.env.example' },
      out: { type: 'string', default: 'workflows/dist' },
      check: { type: 'boolean', default: false },
    },
  });
  const outDir = path.resolve(ROOT, values.out);
  const built = buildAll(path.resolve(ROOT, values.env));

  if (values.check) {
    const stale = built.filter(({ file, text }) => {
      const target = path.join(outDir, file);
      return !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== text;
    });
    if (stale.length > 0) {
      console.error(`Out of date: ${stale.map((s) => s.file).join(', ')}. Run npm run build.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${built.length} workflows in ${values.out} are up to date.`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const { file, text } of built) fs.writeFileSync(path.join(outDir, file), text);
  console.log(`Built ${built.length} workflows into ${values.out} using ${values.env}.`);
}

if (require.main === module) main();

module.exports = { buildAll };
