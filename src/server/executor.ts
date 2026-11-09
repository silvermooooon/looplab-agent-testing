import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";

export const localExecutorId = createHash("sha256")
  .update(`${hostname()}\n${resolve(".")}`)
  .digest("hex");
