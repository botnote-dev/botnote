import { readFile, writeFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));

if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
  throw new Error("package.json version is missing");
}

const version = packageJson.version;

const targets = [
  { path: "packages/cli/package.json", keys: ["version"] },
  { path: ".claude-plugin/marketplace.json", keys: ["metadata.version", "plugins.0.version"] },
  { path: ".cursor-plugin/marketplace.json", keys: ["metadata.version", "plugins.0.version"] },
  { path: "plugins/botnote/.claude-plugin/plugin.json", keys: ["version"] },
  { path: "plugins/botnote/.codex-plugin/plugin.json", keys: ["version"] },
  { path: "plugins/botnote/.cursor-plugin/plugin.json", keys: ["version"] }
];

function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  const target = keys.reduce((current, key) => current?.[key], obj);
  if (!target || !last || !(last in target)) {
    throw new Error(`Missing JSON path ${path}`);
  }
  target[last] = value;
}

for (const target of targets) {
  const json = JSON.parse(await readFile(target.path, "utf8"));
  for (const key of target.keys) {
    setPath(json, key, version);
  }
  await writeFile(target.path, `${JSON.stringify(json, null, 2)}\n`);
}
