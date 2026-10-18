import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  version?: unknown;
}

function readPackageVersion(): string {
  const packageJsonPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../package.json"
  );
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error(`Missing package version in ${packageJsonPath}`);
  }
  return packageJson.version;
}

export const VERSION = readPackageVersion();
