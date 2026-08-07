// ABOUTME: ESLint flat config for the extension source. Type-aware rules over src/.
// ABOUTME: dist/ is generated and node_modules/ is vendored, so both are ignored.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "*.vsix"] },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: tseslint.configs.recommendedTypeChecked,
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // JSON edit routing walks untyped parse output; the surrounding code
      // checks the shape before writing.
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "smart"],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    // node:test's `test()` returns a promise the runner owns; awaiting each call
    // would serialise the suite for no benefit.
    files: ["test/**/*.test.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" },
  }
);
