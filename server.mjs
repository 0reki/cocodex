import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createBrotliCompress, createGzip, constants } from "node:zlib";

const webDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(webDir, "dist");
const indexFile = path.join(distDir, "index.html");
const host = process.env.WEB_HOST?.trim() || "0.0.0.0";
const port = Number(process.env.WEB_PORT || 53332);
const apiTarget = new URL(
  process.env.API_PROXY_TARGET || "http://127.0.0.1:53141",
);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const compressibleExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
]);

function acceptedEncodings(req) {
  const header = String(req.headers["accept-encoding"] || "");
  const weights = new Map();
  for (const value of header.split(",")) {
    const [name, ...parameters] = value.trim().toLowerCase().split(";");
    if (!name) continue;
    const qualityParameter = parameters.find((item) =>
      item.trim().startsWith("q="),
    );
    const quality = qualityParameter
      ? Number(qualityParameter.trim().slice(2))
      : 1;
    weights.set(name, Number.isFinite(quality) ? quality : 0);
  }

  const wildcard = weights.get("*") ?? 0;
  return ["br", "gzip"]
    .map((encoding, preference) => ({
      encoding,
      preference,
      quality: weights.get(encoding) ?? wildcard,
    }))
    .filter((item) => item.quality > 0)
    .sort(
      (left, right) =>
        right.quality - left.quality || left.preference - right.preference,
    )
    .map((item) => item.encoding);
}

function appendVary(current, value) {
  const values = String(current || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) {
    values.push(value);
  }
  return values.join(", ");
}

async function sendFile(req, res, filePath, cacheControl) {
  let responsePath = filePath;
  let contentEncoding = null;
  const isCompressible =
    cacheControl !== "no-store" &&
    compressibleExtensions.has(path.extname(filePath));

  if (isCompressible) {
    for (const encoding of acceptedEncodings(req)) {
      const encodedPath = `${filePath}.${encoding === "br" ? "br" : "gz"}`;
      const encodedStat = await stat(encodedPath).catch(() => null);
      if (encodedStat?.isFile()) {
        responsePath = encodedPath;
        contentEncoding = encoding;
        break;
      }
    }
  }

  const responseStat = await stat(responsePath);
  const headers = {
    "cache-control": cacheControl,
    "content-length": responseStat.size,
    "content-type":
      mimeTypes[path.extname(filePath)] || "application/octet-stream",
  };
  if (isCompressible) headers.vary = "Accept-Encoding";
  if (contentEncoding) headers["content-encoding"] = contentEncoding;
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(responsePath).pipe(res);
}

async function proxyApi(req, res, requestUrl) {
  const target = new URL(requestUrl.pathname + requestUrl.search, apiTarget);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (
      !value ||
      name === "host" ||
      name === "connection" ||
      name === "content-length" ||
      name === "accept-encoding"
    )
      continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  headers.set("accept-encoding", "identity");

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    redirect: "manual",
  });

  const responseHeaders = {};
  upstream.headers.forEach((value, name) => {
    if (
      name !== "content-encoding" &&
      name !== "content-length" &&
      name !== "transfer-encoding"
    ) {
      responseHeaders[name] = value;
    }
  });

  const contentType = upstream.headers.get("content-type") || "";
  const contentLengthHeader = upstream.headers.get("content-length");
  const contentLength =
    contentLengthHeader === null ? null : Number(contentLengthHeader);
  const compressionWorthwhile =
    contentLength === null ||
    !Number.isFinite(contentLength) ||
    contentLength >= 1024;
  const compressApiResponse =
    requestUrl.pathname.startsWith("/api/") &&
    /^(application\/json|text\/)/i.test(contentType) &&
    compressionWorthwhile &&
    upstream.status !== 204 &&
    upstream.status !== 304;
  const contentEncoding = compressApiResponse
    ? acceptedEncodings(req)[0]
    : undefined;
  if (compressApiResponse) {
    responseHeaders.vary = appendVary(responseHeaders.vary, "Accept-Encoding");
  }
  if (contentEncoding) {
    responseHeaders["content-encoding"] = contentEncoding;
  }
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body || req.method === "HEAD") {
    res.end();
    return;
  }

  const bodyStream = Readable.fromWeb(upstream.body);
  if (contentEncoding === "br") {
    await pipeline(
      bodyStream,
      createBrotliCompress({
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      }),
      res,
    );
    return;
  }
  if (contentEncoding === "gzip") {
    await pipeline(bodyStream, createGzip({ level: 6 }), res);
    return;
  }
  await pipeline(bodyStream, res);
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    if (
      requestUrl.pathname.startsWith("/api/") ||
      requestUrl.pathname.startsWith("/v1/") ||
      requestUrl.pathname === "/health"
    ) {
      await proxyApi(req, res, requestUrl);
      return;
    }

    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const relativePath = decodedPath.replace(/^\/+/, "");
    const candidate = path.resolve(distDir, relativePath);
    if (candidate.startsWith(`${distDir}${path.sep}`)) {
      const fileStat = await stat(candidate).catch(() => null);
      if (fileStat?.isFile()) {
        await sendFile(
          req,
          res,
          candidate,
          relativePath === "config.json"
            ? "no-store"
            : relativePath.startsWith("assets/")
              ? "public, max-age=31536000, immutable"
              : "public, max-age=300",
        );
        return;
      }
    }

    await sendFile(req, res, indexFile, "no-cache");
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Request failed",
      }),
    );
  }
});

server.listen(port, host, () => {
  console.log(`CoCodex web listening on http://${host}:${port}`);
});
