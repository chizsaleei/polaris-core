// eslint.config.mjs for polaris-core

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // Ignore build output
  {
    // Skip build outputs and the nested Next.js app that has its own lint setup
    ignores: ['dist/**', 'build/**', 'polaris-coach-web/**']
  },

  // Our server source
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // For now, do not block builds because of `any`
      '@typescript-eslint/no-explicit-any': 'off',

      // Keep unused vars mostly as warnings, but allow `_name` style
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],

      // These are mostly style, so warn only
      'prefer-const': 'warn',

      // Some of the template types use empty interfaces
      '@typescript-eslint/no-empty-object-type': 'off'
    }
  }
)
