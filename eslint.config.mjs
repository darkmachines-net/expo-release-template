/** @file Require file overviews and named callable documentation, including exported and returned APIs. */
import jsdoc from 'eslint-plugin-jsdoc';

export default [
  { ignores: ['.work/**', 'coverage/**', 'artifacts/**'] },
  {
    files: ['**/*.{js,mjs,cjs}'],
    plugins: { jsdoc },
    rules: {
      'jsdoc/require-file-overview': 'error',
      'jsdoc/require-description': 'error',
      'jsdoc/require-jsdoc': ['error', {
        // Include named helpers and object methods so returned API methods are covered too.
        enableFixer: false,
        require: {
          FunctionDeclaration: true,
          FunctionExpression: true,
          ArrowFunctionExpression: true,
          MethodDefinition: true,
        },
      }],
    },
  },
  // Expo evaluates these consumer configuration entrypoints through CommonJS.
  { files: ['examples/expo-only/app.config.js'], languageOptions: { sourceType: 'commonjs' } },
];
