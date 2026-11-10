import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { packagePortableGit } from "./package-portable-git.js";

if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("请在 Apple Silicon Mac 上构建 macOS 便携包");

const nodeVersion = "24.22.1";
const nodeName = `node-v${nodeVersion}-darwin-arm64`;
const nodeSha256 =
  "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7";
const { version } = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};
const releaseDir = resolve(".data/release");
const standardArchive = join(releaseDir, `looplab-${version}.tgz`);
const packageName = `looplab-${version}-darwin-arm64`;
const stage = mkdtempSync(join(releaseDir, ".portable-"));
const app = join(stage, packageName);

try {
  mkdirSync(app);
  execFileSync("/usr/bin/tar", ["-xzf", standardArchive, "-C", app], {
    stdio: "inherit",
  });

  const nodeArchive = join(stage, `${nodeName}.tar.gz`);
  execFileSync(
    "/usr/bin/curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "2",
      "--output",
      nodeArchive,
      `https://nodejs.org/dist/v${nodeVersion}/${nodeName}.tar.gz`,
    ],
    { stdio: "inherit" },
  );
  const sha256 = createHash("sha256")
    .update(readFileSync(nodeArchive))
    .digest("hex");
  if (sha256 !== nodeSha256) throw new Error("Node.js 归档 SHA-256 校验失败");
  execFileSync("/usr/bin/tar", ["-xzf", nodeArchive, "-C", stage], {
    stdio: "inherit",
  });
  const nodeSource = join(stage, nodeName);
  const nodeRoot = join(app, "runtime/node");
  const nodeBin = join(nodeRoot, "bin");
  const node = join(nodeBin, "node");
  mkdirSync(nodeBin, { recursive: true });
  copyFileSync(join(nodeSource, "bin/node"), node);
  copyFileSync(join(nodeSource, "LICENSE"), join(nodeRoot, "LICENSE"));
  execFileSync(
    node,
    [
      join(nodeSource, "lib/node_modules/npm/bin/npm-cli.js"),
      "ci",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: app,
      stdio: "inherit",
      env: { ...process.env, PATH: `${nodeBin}:${process.env.PATH || ""}` },
    },
  );

  const browserPath = join(app, "runtime/browsers");
  execFileSync(
    node,
    ["node_modules/playwright/cli.js", "install", "--only-shell", "chromium"],
    {
      cwd: app,
      stdio: "inherit",
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserPath },
    },
  );
  rmSync(join(browserPath, ".links"), { recursive: true, force: true });

  packagePortableGit(app);
  const launcher = join(app, "Start LoopLab.command");
  copyFileSync("scripts/launch-portable.command", launcher);
  chmodSync(launcher, 0o755);

  const stagedArchive = join(stage, "portable.zip");
  execFileSync(
    "/usr/bin/ditto",
    ["-c", "-k", "--norsrc", "--keepParent", app, stagedArchive],
    { stdio: "inherit" },
  );
  const archive = join(releaseDir, `${packageName}.zip`);
  renameSync(stagedArchive, archive);
  console.log(archive);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
