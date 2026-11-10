import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

const version = "2.56.0";
const archive = `git-${version}.tar.xz`;
const sourceUrl = `https://www.kernel.org/pub/software/scm/git/${archive}`;
const sha256 =
  "26c56c296b38c0695b26fa95f475f1d01704d2d38e73465ca30b0b2f5dc789d3";
const macosDeploymentTarget = "13.0";
const makeFlags = [
  "CC=/usr/bin/clang",
  "CFLAGS=-O2 -Wall",
  "NO_GETTEXT=YesPlease",
  "NO_OPENSSL=YesPlease",
  "NO_CURL=YesPlease",
  "NO_EXPAT=YesPlease",
  "NO_PERL=YesPlease",
  "NO_PYTHON=YesPlease",
  "NO_TCLTK=YesPlease",
  "NO_RUST=YesPlease",
];

export function packagePortableGit(stagingRoot: string) {
  const work = mkdtempSync(join(tmpdir(), "looplab-portable-git-"));
  const sourceArchive = join(work, archive);
  try {
    console.log(`Building Git ${version} for the portable package`);
    execFileSync("/usr/bin/curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--retry",
      "2",
      "--max-time",
      "120",
      "--output",
      sourceArchive,
      sourceUrl,
    ]);
    const digest = createHash("sha256")
      .update(readFileSync(sourceArchive))
      .digest("hex");
    if (digest !== sha256) throw new Error(`Git ${version} 源码校验失败`);
    execFileSync("/usr/bin/tar", ["-xf", sourceArchive], { cwd: work });
    const source = join(work, `git-${version}`);
    execFileSync(
      "/usr/bin/make",
      [`-j${Math.min(availableParallelism(), 8)}`, ...makeFlags, "git"],
      {
        cwd: source,
        env: {
          ...process.env,
          MACOSX_DEPLOYMENT_TARGET: macosDeploymentTarget,
        },
        stdio: "inherit",
      },
    );

    const target = join(stagingRoot, "runtime", "git");
    const binary = join(target, "bin", "git");
    mkdirSync(join(target, "bin"), { recursive: true });
    copyFileSync(join(source, "git"), binary);
    chmodSync(binary, 0o755);
    copyFileSync(join(source, "COPYING"), join(target, "COPYING"));
    copyFileSync(sourceArchive, join(target, archive));
    writeFileSync(
      join(target, "BUILD-GIT.txt"),
      [
        `Git ${version} (macOS arm64)`,
        `Source: ${sourceUrl}`,
        `SHA-256: ${sha256}`,
        "",
        "Build with Xcode Command Line Tools:",
        `tar -xf ${archive}`,
        `cd git-${version}`,
        `MACOSX_DEPLOYMENT_TARGET=${macosDeploymentTarget} /usr/bin/make ${makeFlags.map((flag) => `'${flag}'`).join(" ")} git`,
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
