// Copies the dashboard page next to the compiled server; tsc does not copy .html files.
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
copyFileSync("src/webui.html", "dist/webui.html");
