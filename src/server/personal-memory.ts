import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { HttpError } from "./repository.js";

export const personalMemoryLimit = 6000;
export const personalMemoryContent = z.string().trim().max(personalMemoryLimit);

export type PersonalMemory = { content: string; version: string | null };

const ref = "refs/heads/main";
const file = "MEMORY.md";
const blank: PersonalMemory = { content: "", version: null };

export async function readPersonalMemory(
  userId: string,
): Promise<PersonalMemory> {
  return read(repositoryPath(userId));
}

export async function writePersonalMemory(
  userId: string,
  input: PersonalMemory,
  source?: string,
): Promise<PersonalMemory> {
  const repository = repositoryPath(userId);
  const current = await read(repository);
  if (current.version !== input.version) throw conflict();
  if (current.content === input.content) return current;
  await initialize(repository);

  const inRepository = `--git-dir=${repository}`;
  const blob = (
    await git([inRepository, "hash-object", "-w", "--stdin"], input.content)
  ).trim();
  const tree = (
    await git([inRepository, "mktree"], `100644 blob ${blob}\t${file}\n`)
  ).trim();
  const version = (
    await git([
      inRepository,
      "commit-tree",
      tree,
      ...(current.version ? ["-p", current.version] : []),
      "-m",
      input.content ? "Update personal memory" : "Clear personal memory",
      "-m",
      `Memory-Source: ${source ? `run:${source}` : "account"}`,
    ])
  ).trim();

  // Git publishes the new revision only if the user's last-read ref still matches.
  try {
    await git([
      inRepository,
      "update-ref",
      ref,
      version,
      current.version ?? "0".repeat(40),
    ]);
  } catch (error) {
    if ((await head(repository)) !== current.version) throw conflict();
    throw error;
  }
  return { content: input.content, version };
}

function repositoryPath(userId: string) {
  const owner = createHash("sha256").update(userId).digest("hex");
  return join(config.personalMemoryDir, `${owner}.git`);
}

async function read(repository: string): Promise<PersonalMemory> {
  if (!(await exists(repository))) return { ...blank };
  const version = await head(repository);
  if (!version) return { ...blank };
  const content = await git([
    `--git-dir=${repository}`,
    "show",
    `${version}:${file}`,
  ]);
  return { content, version };
}

async function head(repository: string) {
  const version = await git(
    [`--git-dir=${repository}`, "rev-parse", "--verify", "--quiet", ref],
    undefined,
    1,
  );
  return version.trim() || null;
}

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw unavailable();
  }
}

async function initialize(repository: string) {
  if (await exists(repository)) return;
  try {
    await mkdir(config.personalMemoryDir, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(config.personalMemoryDir, ".init-"));
    try {
      await git([
        "init",
        "--bare",
        "--initial-branch=main",
        "--object-format=sha1",
        "--template=",
        directory,
      ]);
      await rename(directory, repository);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } catch {
    throw unavailable();
  }
}

function git(
  args: string[],
  input?: string,
  acceptedCode?: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args],
      {
        timeout: 10000,
        maxBuffer: 64 * 1024,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "LoopLab Memory",
          GIT_COMMITTER_NAME: "LoopLab Memory",
          GIT_AUTHOR_EMAIL: "memory@looplab.local",
          GIT_COMMITTER_EMAIL: "memory@looplab.local",
        },
      },
      (error, stdout) => {
        if (
          !error ||
          (acceptedCode !== undefined && error.code === acceptedCode)
        )
          resolve(stdout);
        else reject(unavailable());
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

function unavailable() {
  return new HttpError(503, "个人记忆暂不可用，请检查本机 Git 和记忆目录");
}

function conflict() {
  return new HttpError(409, "个人记忆已更新，请读取最新版本后重试");
}
