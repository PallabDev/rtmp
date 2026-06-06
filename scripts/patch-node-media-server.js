const fs = require("fs");
const path = require("path");

const target = path.join(
  __dirname,
  "..",
  "node_modules",
  "node-media-server",
  "src",
  "node_trans_server.js"
);

if (!fs.existsSync(target)) {
  console.log("[patch-node-media-server] node_trans_server.js not found, skipping.");
  process.exit(0);
}

const source = fs.readFileSync(target, "utf8");
const broken = "ffmpeg version: ${version}";
const fixed = "ffmpeg: ${this.config.trans.ffmpeg}";

if (source.includes(fixed)) {
  console.log("[patch-node-media-server] already patched.");
  process.exit(0);
}

if (!source.includes(broken)) {
  console.log("[patch-node-media-server] expected bug text not found, skipping.");
  process.exit(0);
}

fs.writeFileSync(target, source.replace(broken, fixed));
console.log("[patch-node-media-server] patched trans server startup log.");
