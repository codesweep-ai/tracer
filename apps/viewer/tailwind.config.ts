import path from "node:path";
import type { Config } from "tailwindcss";

export default {
  content: [
    path.resolve(__dirname, "index.html"),
    path.resolve(__dirname, "src/**/*.{ts,tsx}"),
    path.resolve(__dirname, "node_modules/@codesweep-ai/ui/src/**/*.{ts,tsx}"),
    path.resolve(__dirname, "../../vendor/codesweep-ui/src/**/*.{ts,tsx}"),
  ],
  theme: { extend: {} },
  plugins: [],
} satisfies Config;
