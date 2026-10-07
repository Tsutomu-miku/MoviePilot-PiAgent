import { cp, mkdir, readFile, rm, writeFile, chmod, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import console from "node:console";
import Database from "better-sqlite3";

const project = process.cwd();
const version = JSON.parse(await readFile("package.v2.json", "utf8")).PiAgentBridge.version;
const platform = `${process.platform}-${process.arch}`;
if (!["linux-x64", "linux-arm64"].includes(platform)) {
  throw new Error("Plugin runtime packaging requires Linux x64 or arm64");
}
const output = resolve(process.env.PLUGIN_ARTIFACT_DIR ?? "work/plugin-release");
const stage = join(output, "stage");
await mkdir(output, { recursive: true });
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
for (const path of [
  "package.json",
  "package-lock.json",
  "apps/api/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
]) {
  await mkdir(join(stage, path, ".."), { recursive: true });
  await cp(join(project, path), join(stage, path));
}
function run(command, args, cwd = stage) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}
run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-fund", "--no-audit"]);
for (const path of [
  "apps/api/dist/src",
  "apps/api/skills",
  "apps/api/migrations",
  "apps/web/dist",
  "packages/contracts/dist",
]) {
  await cp(join(project, path), join(stage, path), { recursive: true });
}
await mkdir(join(stage, "bin"));
await cp(process.execPath, join(stage, "bin/node"));
await chmod(join(stage, "bin/node"), 0o755);
// Native code is built and tested on the packaging host, then shipped with its Node version.
const nativeObjects = new Set(process.report.getReport().sharedObjects);
const database = new Database(":memory:");
database.prepare("SELECT 1").get();
database.close();
const nativeDirectory = join(project, "node_modules/better-sqlite3");
const loadedAddon = process.report
  .getReport()
  .sharedObjects.filter(
    (path) =>
      !nativeObjects.has(path) && path.startsWith(nativeDirectory) && path.endsWith(".node"),
  );
if (loadedAddon.length !== 1) {
  throw new Error("Expected one tested better-sqlite3 native addon");
}
await rm(join(stage, "node_modules/better-sqlite3/prebuilds"), { recursive: true, force: true });
const addon = `node_modules/better-sqlite3/prebuilds/linux-${process.arch}.node`;
await mkdir(join(stage, addon, ".."), { recursive: true });
await cp(loadedAddon[0], join(stage, addon));
run(join(stage, "bin/node"), [
  "--input-type=module",
  "-e",
  `
import Database from "better-sqlite3";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const database = new Database(":memory:");
database.prepare("SELECT 1").get();
database.close();
if (typeof ModelRuntime.create !== "function") {
  throw new Error("Pi runtime missing");
}
`,
]);
const archiveName = `piagent-runtime-${version}-${platform}.tar.gz`;
run("tar", ["-czf", join(output, archiveName), "-C", stage, "."]);
const archive = await readFile(join(output, archiveName));
const manifest = {
  version,
  platforms: {
    [platform]: {
      url: `https://github.com/Tsutomu-miku/MoviePilot-PiAgent/releases/download/PiAgentBridge_v${version}/${archiveName}`,
      sha256: createHash("sha256").update(archive).digest("hex"),
    },
  },
};
await writeFile(join(output, "runtime-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const pluginStage = join(output, "plugin");
await rm(pluginStage, { recursive: true, force: true });
await mkdir(pluginStage);
for (const name of await readdir(join(project, "plugins.v2/piagentbridge"))) {
  if (name.endsWith(".py")) {
    await cp(join(project, "plugins.v2/piagentbridge", name), join(pluginStage, name));
  }
}
await cp(join(output, "runtime-manifest.json"), join(pluginStage, "runtime-manifest.json"));
run("python3", [
  join(project, "scripts/zip-plugin.py"),
  pluginStage,
  join(output, `piagentbridge_v${version}.zip`),
]);
console.log(`Packaged ${platform}: ${(archive.length / 1024 / 1024).toFixed(1)} MiB compressed`);
console.log(`Artifacts: ${output}`);
