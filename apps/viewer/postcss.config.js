import path from "node:path";
import { fileURLToPath } from "node:url";
const dirname = path.dirname(fileURLToPath(import.meta.url));
export default { plugins: { tailwindcss: { config: path.resolve(dirname, "tailwind.config.ts") }, autoprefixer: {} } };
