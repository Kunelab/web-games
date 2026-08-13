// Identical to apps/back and apps/front. Prettier resolves config per file from
// the nearest one upwards, so without a copy here the root `format` script
// reformatted this package with Prettier's own defaults instead.
module.exports = {
  trailingComma: 'none',
  useTabs: false,
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  jsxBracketSameLine: false,
  endOfLine: 'lf',
  printWidth: 120
};
