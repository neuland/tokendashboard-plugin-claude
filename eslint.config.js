'use strict';

module.exports = [
  {
    files: ['**/*.js'],
    rules: {
      curly: ['error', 'all'],
      'brace-style': ['error', '1tbs'],
      indent: ['error', 2],
      'no-trailing-spaces': 'error',
      eqeqeq: 'error',
      'no-unused-vars': 'error',
      'no-var': 'error',
      'max-statements-per-line': ['error', { max: 1 }],
    },
  },
];
