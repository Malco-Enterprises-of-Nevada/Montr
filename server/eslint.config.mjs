import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import eslintPluginPrettier from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'tests/', 'coverage/', 'jest.config.js', 'jest.config.adapters.js', 'src/web/public/**'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  eslintConfigPrettier,
  eslintPluginPrettier,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Express req.body is typed as any — safe because Zod validates at route boundaries
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // Passing class methods as callbacks in SQL adapter is safe
      '@typescript-eslint/unbound-method': 'off',
      // Empty async stubs in adapter interfaces
      '@typescript-eslint/require-await': 'off',
      // Aliasing this in adapter constructors
      '@typescript-eslint/no-this-alias': 'off',
      // CommonJS require in WebSocket dynamic imports
      '@typescript-eslint/no-require-imports': 'off',
      // Template literal edge cases (never type in exhaustive switch, unknown in catch)
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Winston format printf stack parameter
      '@typescript-eslint/no-base-to-string': 'off',
      // Fire-and-forget async in thumbnail generation
      '@typescript-eslint/no-floating-promises': 'off',
      'class-methods-use-this': 'off',
      'no-console': [
        'warn',
        {
          allow: ['warn', 'error'],
        },
      ],
      'no-underscore-dangle': 'off',
    },
  },
);
