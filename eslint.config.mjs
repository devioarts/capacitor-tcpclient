// @ts-check
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
  // Ignored paths (migrated from .eslintignore + new paths for ESLint 10 flat config)
  {
    ignores: [
      'dist/',
      'node_modules/',
      'build/',
      '.build/',
      'example-app/',
      'android/',
      'ios/',
      'electron/*.cjs',
      'README.md',
    ],
  },
  // TypeScript source files
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended, eslintConfigPrettier],
    rules: {
      // Matches the rules from the former @ionic/eslint-config/recommended
      'no-fallthrough': 'off',
      'no-constant-condition': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/explicit-module-boundary-types': [
        'warn',
        { allowArgumentsExplicitlyTypedAsAny: true },
      ],
    },
  },
);
