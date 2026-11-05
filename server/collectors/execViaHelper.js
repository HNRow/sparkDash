// 通过常驻的小进程（execHelper.cjs）执行子命令。
//
// 主进程 VSZ 很大（V8 预留 20GB+），在本机/容器内核上 fork 会偶发阻塞 1–2 秒，
// 而采集每 2 秒就要起十来个 ssh。把 fork 交给一个 VSZ 只有几百 MB 的辅助进程，
// 主进程的事件循环就不会再被子进程创建卡住。
import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), "execHelper.cjs");
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/** @type {import("node:child_process").ChildProcess | null} */
let helper = null;
let helperLines = null;
let seq = 0;
/** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
const pending = new Map();
let consecutiveStartFailures = 0;

function rejectAll(error) {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(error);
    pending.delete(id);
  }
}

function ensureHelper() {
  if (helper && helper.exitCode === null) return helper;
  if (consecutiveStartFailures >= 5) {
    // 连续起不来就别再尝试，由调用方退回到直接执行。
    return null;
  }
  helper = spawn(process.execPath, ["--jitless", HELPER], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  helper.once("error", (err) => {
    consecutiveStartFailures += 1;
    helper = null;
    rejectAll(err);
  });
  helper.once("exit", () => {
    helperLines?.close();
    helperLines = null;
    helper = null;
    rejectAll(new Error("exec helper exited"));
  });
  helperLines = readline.createInterface({ input: helper.stdout });
  helperLines.on("line", (line) => {
    let res;
    try {
      res = JSON.parse(line);
    } catch {
      return;
    }
    const entry = pending.get(res.id);
    if (!entry) return;
    pending.delete(res.id);
    clearTimeout(entry.timer);
    entry.resolve(res);
  });
  return helper;
}

/**
 * 用辅助进程执行命令；辅助进程不可用时退回直接 execFile（会阻塞，但保证可用）。
 * 返回结构与 execFile 回调的 err/stdout/stderr 等价。
 * @param {string} file
 * @param {string[]} args
 * @param {{timeout?: number, env?: object, maxBuffer?: number, input?: string}} [options]
 * @returns {Promise<{errCode: any, signal: string|null, killed: boolean, message: string|null, stdout: string, stderr: string}>}
 */
export function execViaHelper(file, args, options = {}) {
  const proc = ensureHelper();
  if (!proc) {
    return import("node:child_process").then(
      ({ execFile }) =>
        new Promise((resolve) => {
          let child;
          try {
            child = execFile(
              file,
              args,
              {
                timeout: options.timeout,
                env: options.env,
                maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
                encoding: "utf8",
              },
              (err, stdout, stderr) =>
                resolve({
                  errCode: err?.code ?? null,
                  signal: err?.signal ?? null,
                  killed: Boolean(err?.killed),
                  message: err?.message ?? null,
                  stdout: stdout ?? "",
                  stderr: stderr ?? "",
                })
            );
          } catch (err) {
            resolve({ errCode: err.code ?? null, signal: null, killed: false, message: err.message, stdout: "", stderr: "" });
            return;
          }
          if (typeof options.input === "string") child.stdin?.end(options.input);
        })
    );
  }
  const id = ++seq;
  const timeout = options.timeout ?? 0;
  const request = JSON.stringify({
    id,
    file,
    args,
    env: options.env,
    timeoutMs: timeout || undefined,
    maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
    input: options.input,
  });
  return new Promise((resolve, reject) => {
    // 辅助进程自身卡住时的兜底：比命令超时多 5 秒。
    const guard = timeout > 0 ? timeout + 5000 : 0;
    const timer = guard
      ? setTimeout(() => {
          pending.delete(id);
          reject(new Error(`exec helper timed out after ${guard}ms for ${file}`));
        }, guard)
      : null;
    pending.set(id, { resolve, reject, timer });
    const ok = proc.stdin.write(request + "\n");
    if (!ok) {
      proc.stdin.once("drain", () => {});
    }
    consecutiveStartFailures = 0;
  });
}

/** 关闭辅助进程（测试与优雅退出用）。 */
export function closeExecHelper() {
  if (!helper) return;
  try {
    helper.stdin.end();
    helper.kill();
  } catch {
    /* ignore */
  }
  rejectAll(new Error("exec helper closed"));
  helper = null;
}