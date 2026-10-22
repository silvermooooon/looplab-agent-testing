import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliCompress, gzip, constants } from "node:zlib";
import { promisify } from "node:util";
const brotli = promisify(brotliCompress),
  gz = promisify(gzip);
async function compress(dir: string) {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, item.name);
    if (item.isDirectory()) {
      await compress(path);
      continue;
    }
    if (!/\.(js|css|html|svg)$/.test(item.name)) continue;
    const bytes = await readFile(path);
    await Promise.all([
      writeFile(
        path + ".br",
        await brotli(bytes, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
        }),
      ),
      writeFile(path + ".gz", await gz(bytes, { level: 9 })),
    ]);
  }
}
await compress("web-dist");
console.log("Precompressed web assets: Brotli + gzip");
