module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
  },
  overrides: [
    {
      // Browser-side UI (calibrator + labeler) runs in the user's browser, not Node.
      files: ['src/calibrate/public/**/*.js', 'src/dataset/public/**/*.js'],
      env: { browser: true, node: false },
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
  ],
}
