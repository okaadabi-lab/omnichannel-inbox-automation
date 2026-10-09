'use strict';

const js = require('@eslint/js');
const globals = require('globals');

const n8nCodeNodeGlobals = {
  $: 'readonly',
  $input: 'readonly',
  $json: 'readonly',
  $execution: 'readonly',
  __require: 'readonly',
  CONFIG: 'readonly',
};

module.exports = [
  { ignores: ['node_modules/', 'workflows/dist/', 'workflows/local/', '.e2e/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // src/ is injected into n8n Code nodes, which have no Node.js built-ins unless the
    // instance allow-lists them, so these modules must stay dependency-free.
    files: ['src/**/*.js'],
    languageOptions: { globals: { ...globals.es2021 } },
    rules: {
      'no-restricted-globals': ['error', 'process', 'Buffer', '__dirname', '__filename'],
    },
  },
  {
    files: ['workflows/code/**/*.js'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { globalReturn: true } },
      globals: { ...globals.es2021, ...n8nCodeNodeGlobals },
    },
  },
];
