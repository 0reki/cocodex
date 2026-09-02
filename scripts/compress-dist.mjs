import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);
const distDir = path.resolve("dist");
const minimumSize = 1024;
const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
]);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(entryPath) : [entryPath];
    }),
  );
  return nested.flat();
}

const files = (await listFiles(distDir)).filter((filePath) =>
  compressibleExtensions.has(path.extname(filePath)),
);

for (const filePath of files) {
  const source = await readFile(filePath);
  if (source.byteLength < minimumSize) continue;

  const [brotli, gzipped] = await Promise.all([
    compressBrotli(source, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 9,
      },
    }),
    compressGzip(source, { level: 9 }),
  ]);
  await Promise.all([
    writeFile(`${filePath}.br`, brotli),
    writeFile(`${filePath}.gz`, gzipped),
  ]);
}
