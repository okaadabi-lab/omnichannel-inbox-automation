'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const credentials = require('./lib/credentials');
const { validateWorkflows } = require('./lib/validate-workflow');

const ERROR_WORKFLOW_ID = 'oiaErrorHandler';

function main() {
  const { values } = parseArgs({
    options: { dir: { type: 'string', default: 'workflows/dist' } },
  });
  const dir = path.resolve(__dirname, '..', values.dir);
  const entries = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({ file, workflow: JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) }));

  const problems = validateWorkflows(entries, { credentials, errorWorkflowId: ERROR_WORKFLOW_ID });
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) in ${values.dir}:`);
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${entries.length} workflows in ${values.dir} are valid.`);
}

main();
