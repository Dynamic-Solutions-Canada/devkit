import js from '@eslint/js'
import globals from 'globals'

// The shared flat-config skeleton (STYLE-3), JavaScript and Node parts only: devkit has no
// TypeScript and no web code, so typescript-eslint and the React rules do not apply.
export default [
  {
    ignores: ['**/node_modules/**', 'tmp/**', '.artifacts/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // The VS Code extension runs as CommonJS inside the editor's extension host.
    files: ['vscode-extension/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
    },
  },
]
