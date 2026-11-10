import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};
const releaseDir = ".data/release";
const archive = join(releaseDir, `looplab-${version}.tgz`);
const files = [
  "package.json",
  "package-lock.json",
  ".env.example",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "docs/architecture.md",
  "docs/pi-source-manifest.json",
  "docs/ci-workflow.template.yml",
  "docs/images/agent-chat.png",
  "licenses/pi-MIT.txt",
  "dist/src",
  "dist/scripts/configure-llm.js",
  "dist/scripts/migrate.js",
  "dist/scripts/live-model.js",
  "web-dist",
];

mkdirSync(releaseDir, { recursive: true });
const stagingDir = mkdtempSync(join(releaseDir, ".package-"));
const stagedArchive = join(stagingDir, "release.tgz");
try {
  execFileSync("tar", ["-czf", stagedArchive, "--", ...files], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdio: "inherit",
  });
  renameSync(stagedArchive, archive);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
console.log(archive);
