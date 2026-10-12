#!/usr/bin/env node
/**
 * Downloads the 3D map's ground photos, listed in
 * src/client/render/three/ground-photos.json, from Poly Haven (every texture
 * there is CC0) into resources/textures/terrain/, along with the index.json
 * the game reads them by and a CREDITS.md.
 *
 *   node scripts/textures/fetch_ground_photos.mjs            2k photos
 *   node scripts/textures/fetch_ground_photos.mjs --res 1k   smaller files
 *   node scripts/textures/fetch_ground_photos.mjs --list     ground textures to pick from
 *
 * To swap a photo, change its "polyhaven" id in ground-photos.json (an id
 * from --list, or the last part of a polyhaven.com/a/<id> page) and run this
 * again. Behind an HTTPS proxy, run it with NODE_USE_ENV_PROXY=1.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const CONFIG = path.join(ROOT, "src/client/render/three/ground-photos.json");
const OUT = path.join(ROOT, "resources/textures/terrain");
const API = "https://api.polyhaven.com";
const HEADERS = { "User-Agent": "openfront-fork-ground-photos" };
// The maps the game reads, and what Poly Haven calls them.
const MAPS = {
  color: ["Diffuse", "diff"],
  normal: ["nor_gl"],
  rough: ["Rough", "rough"],
  height: ["Displacement", "disp"],
};
const FORMATS = ["jpg", "png"];
const GROUND =
  /aerial|terrain|ground|grass|rock|snow|sand|soil|dirt|forest|leaves|mud|gravel|beach|cliff/i;

async function get(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

/** The url of a map at a resolution, in the first format available. */
function pick(files, names, res) {
  for (const name of names) {
    const key = Object.keys(files).find(
      (k) => k.toLowerCase() === name.toLowerCase(),
    );
    const sizes = key === undefined ? undefined : files[key][res];
    if (sizes === undefined) continue;
    for (const ext of FORMATS) {
      if (sizes[ext]?.url) return { url: sizes[ext].url, ext };
    }
  }
  return null;
}

async function list() {
  const assets = await (await get(`${API}/assets?t=textures`)).json();
  for (const [id, a] of Object.entries(assets).sort()) {
    const cats = a.categories ?? [];
    if (GROUND.test(id) || cats.some((c) => GROUND.test(c))) {
      console.log(`${id.padEnd(32)} ${a.name}  [${cats.join(", ")}]`);
    }
  }
}

async function download(res) {
  const { layers } = JSON.parse(await fs.readFile(CONFIG, "utf8"));
  await fs.mkdir(OUT, { recursive: true });
  for (const f of await fs.readdir(OUT)) {
    if (f !== ".gitkeep") await fs.rm(path.join(OUT, f));
  }
  const index = { source: "Poly Haven, CC0", resolution: res, layers: {} };
  const credits = [
    "# Ground photos",
    "",
    "Downloaded by `scripts/textures/fetch_ground_photos.mjs` from",
    "[Poly Haven](https://polyhaven.com). All are CC0 (public domain).",
    "",
  ];
  let failed = false;
  for (const layer of layers) {
    const id = layer.polyhaven;
    const files = await (await get(`${API}/files/${id}`)).json();
    const info = await (await get(`${API}/info/${id}`)).json();
    const entry = {};
    for (const [map, names] of Object.entries(MAPS)) {
      const found = pick(files, names, res);
      if (found === null) {
        console.warn(`${layer.key}: ${id} has no ${map} map at ${res}`);
        continue;
      }
      const file = `${layer.key}_${map}.${found.ext}`;
      const bytes = Buffer.from(await (await get(found.url)).arrayBuffer());
      await fs.writeFile(path.join(OUT, file), bytes);
      entry[map] = file;
      console.log(`${file}  ${(bytes.length / 1e6).toFixed(1)} MB`);
    }
    if (entry.color === undefined || entry.normal === undefined) {
      console.error(`${layer.key}: ${id} needs at least colour and normal`);
      failed = true;
    }
    index.layers[layer.key] = entry;
    const authors = Object.keys(info.authors ?? {}).join(", ");
    credits.push(
      `- ${layer.key}: [${info.name ?? id}](https://polyhaven.com/a/${id})` +
        (authors ? ` by ${authors}` : ""),
    );
  }
  await fs.writeFile(
    path.join(OUT, "index.json"),
    `${JSON.stringify(index, null, 2)}\n`,
  );
  await fs.writeFile(path.join(OUT, "CREDITS.md"), `${credits.join("\n")}\n`);
  if (failed) process.exit(1);
}

const args = process.argv.slice(2);
if (args.includes("--list")) {
  await list();
} else {
  const i = args.indexOf("--res");
  await download(i >= 0 ? args[i + 1] : "2k");
}
