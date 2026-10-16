// Shared ESLint flat config for every TypeScript package in the monorepo.
// Apps can import `base` and extend it (see apps/web/eslint.config.mjs).
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import prettier from "eslint-config-prettier";
import globals from "globals";
import tseslint from "typescript-eslint";

export const ignores = [
  "**/node_modules/**",
  "**/dist/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/coverage/**",
  "**/next-env.d.ts",
  "packages/shared/src/db.types.ts",
  "packages/contracts/**",
  "apps/ai/**",
  "treecord-backend-kit/**",
];

export const base = defineConfig(
  { ignores },
  js.configs.recommended,
  tseslint.configs.strict,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  prettier,
);

export default base;
