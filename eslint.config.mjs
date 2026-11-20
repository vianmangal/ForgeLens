import tsParser from "@typescript-eslint/parser";
import globals from "globals";

const rules = {
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-fallthrough": "error",
  "no-unsafe-finally": "error",
  "use-isnan": "error"
};
export default [
  { ignores: ["node_modules/**", ".local/**", "dist/**", "build/**"] },
  { files: ["src/**/*.ts"], languageOptions: { parser: tsParser }, rules },
  { files: ["test/**/*.cjs", "scripts/**/*.mjs", "integration/**/*.cjs", "*.mjs"],
    languageOptions: { globals: globals.node }, rules: { ...rules, "no-undef": "error" } },
  { files: ["media/**/*.js"], languageOptions: { globals: { ...globals.browser, acquireVsCodeApi: "readonly" } },
    rules: { ...rules, "no-undef": "error" } }
];
