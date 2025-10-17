module.exports = {
  env: {
    es2022: true,
    node: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    sourceType: 'module',
    ecmaVersion: 2022
  },
  rules: {
    'no-console': 'off'
  }
};
