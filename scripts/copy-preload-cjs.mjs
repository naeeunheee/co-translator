import fs from "node:fs";
import path from "node:path";

const source = path.join("dist", "preload-cjs", "preload", "preload.js");
const destination = path.join("dist", "preload", "preload.cjs");

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(source, destination);
fs.rmSync(path.join("dist", "preload-cjs"), { recursive: true, force: true });
