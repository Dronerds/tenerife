import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // public/ is staged from node_modules by postinstall and public/data/ is
  // generated; neither is ours to lint.
  { ignores: ['dist', 'public', 'captures', 'tools/data', 'tools/.venv'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Allow the `_name` convention for values discarded on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The tools/ scripts run under Node and sit outside tsconfig's include, so
    // they get the untyped rules plus Node globals. Browser globals too: the
    // callbacks capture.mjs hands to page.evaluate are serialised and run in
    // the page, where `window` is the one that matters.
    files: ['tools/**/*.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
)
