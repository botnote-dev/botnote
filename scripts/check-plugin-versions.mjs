import { readFile } from "node:fs/promises";

const files = [
  ["server package", "package.json", "version"],
  ["CLI package", "packages/cli/package.json", "version"],
  ["Claude marketplace metadata", ".claude-plugin/marketplace.json", "metadata.version"],
  ["Claude marketplace plugin", ".claude-plugin/marketplace.json", "plugins.0.version"],
  ["Cursor marketplace metadata", ".cursor-plugin/marketplace.json", "metadata.version"],
  ["Cursor marketplace plugin", ".cursor-plugin/marketplace.json", "plugins.0.version"],
  ["Claude plugin manifest", "plugins/botnote/.claude-plugin/plugin.json", "version"],
  ["Codex plugin manifest", "plugins/botnote/.codex-plugin/plugin.json", "version"],
  ["Cursor plugin manifest", "plugins/botnote/.cursor-plugin/plugin.json", "version"]
];

function getPath(obj, path) {
  return path.split(".").reduce((value, key) => value?.[key], obj);
}

const versions = await Promise.all(
  files.map(async ([label, path, keyPath]) => {
    const json = JSON.parse(await readFile(path, "utf8"));
    return { label, path, keyPath, version: getPath(json, keyPath) };
  })
);

const expected = versions[0]?.version;
const mismatches = versions.filter((entry) => entry.version !== expected);

if (!expected || mismatches.length > 0) {
  console.error(`Package and plugin versions must match package.json (${expected ?? "missing"}).`);
  for (const entry of versions) {
    console.error(`${entry.version === expected ? "OK" : "MISMATCH"} ${entry.label}: ${entry.path} ${entry.keyPath}=${entry.version ?? "missing"}`);
  }
  process.exitCode = 1;
}
