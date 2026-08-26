// Flat ESLint config. Goal is NOT maximal style policing. It is to mechanically
// enforce the security invariants from ARCHITECTURE.md 9.1 that were previously guarded only by
// human review, plus catch dead code. Prettier owns formatting (see .prettierrc.json);
// eslint-config-prettier turns off any rule that would fight it.
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
  { ignores: ['dist/**', 'dev-dist/**', 'node_modules/**', 'public/**', 'examples/**', '*.config.*'] },
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
      // Deliberate escape hatch for intentional throwaways; the codebase uses `_`-prefixed catch vars.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // WebCrypto/WebRTC/worker surfaces are loosely typed; the code is careful and typechecked by tsc.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
)
