import fs from "fs";
import path from "path";

/**
 * Where the built frontend lives. Docker compose bind-mounts ./dist over the image's own
 * build, so a checkout that was never built on the host (or a fresh clone after an
 * upgrade) leaves an empty mount that hides it. The image keeps a second copy in
 * dist-baked. Use ./dist when it has an index.html, unless the baked copy is newer: a host
 * build from before `git pull` + `docker compose up --build` must not shadow the new image.
 * Checked per request, so a host `npm run build` takes over without a restart.
 */
/** resolveFrontendDir 的结果缓存：静态目录在 USB 上，每个请求两次 existsSync 会被存储抖动拖住。 */
let _cache = null;
const CACHE_MS = 5000;

export function resolveFrontendDir(root, exists = fs.existsSync, mtimeMs = defaultMtime) {
  // 注入 exists/mtime 时（测试）不用缓存，保持逐次判断。
  const cacheable = exists === fs.existsSync && mtimeMs === defaultMtime;
  if (cacheable && _cache && _cache.root === root && Date.now() - _cache.at < CACHE_MS) {
    return _cache.value;
  }
  const result = resolveUncached(root, exists, mtimeMs);
  if (cacheable) _cache = { root, at: Date.now(), value: result };
  return result;
}

function resolveUncached(root, exists, mtimeMs) {
  const found = ["dist", "dist-baked"]
    .map((name) => path.join(root, name))
    .filter((dir) => exists(path.join(dir, "index.html")));
  if (found.length <= 1) return found[0] ?? null;
  const [host, baked] = found;
  try {
    return mtimeMs(path.join(baked, "index.html")) > mtimeMs(path.join(host, "index.html")) ? baked : host;
  } catch {
    return host;
  }
}

function defaultMtime(file) {
  return fs.statSync(file).mtimeMs;
}

export const FRONTEND_MISSING_MESSAGE =
  "Frontend not built. On the host run `npm run build`, or rebuild the image with " +
  "`docker compose up --build -d`. For development use `npm run dev`.";
