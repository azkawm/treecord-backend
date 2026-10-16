import nextPlugin from "@next/eslint-plugin-next";
import { defineConfig } from "eslint/config";
import globals from "globals";
import { base } from "../../eslint.config.mjs";

export default defineConfig(base, nextPlugin.configs["core-web-vitals"], {
  files: ["app/**/*.tsx", "components/**/*.tsx"],
  languageOptions: {
    globals: { ...globals.browser },
  },
});
