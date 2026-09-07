// Flat ESLint config. Scope is the security invariants in ARCHITECTURE.md 9.1, expressed
// as AST rules so they are enforced mechanically rather than by review, plus dead-code
// detection. Prettier owns formatting (.prettierrc.json), and eslint-config-prettier
// disables the rules that would fight it.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import nounsanitized from 'eslint-plugin-no-unsanitized'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

// The security invariants, as AST rules (see ARCHITECTURE.md 9.1):
//  - never assign a string to innerHTML/outerHTML/insertAdjacentHTML (Trusted Types + no XSS sink)
//  - never write .style.cssText from a string, and never pass a `style` prop to el() (CSP style-src 'self')
// Per-property CSSOM setters (node.style.left = ...) remain allowed; they are not the banned sink.
const noRestricted = [
  'error',
  {
    selector: "AssignmentExpression[left.property.name='cssText']",
    message: "No .style.cssText from a string. Use a CSS class in tokens.css (CSP style-src 'self').",
  },
  {
    selector: "CallExpression[callee.name='el'] > ObjectExpression:nth-child(2) > Property[key.name='style']",
    message: "No inline style prop on el(). Use a CSS class in tokens.css (CSP style-src 'self').",
  },
]

export default tseslint.config(
  { ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', 'public/**', '*.config.*'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  nounsanitized.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.worker },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      'no-restricted-syntax': noRestricted,
      // Escape hatch for intentional throwaways; catch vars here are `_`-prefixed.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // WebCrypto, WebRTC and worker surfaces are loosely typed; tsc covers these call sites.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
)
