// 子进程代跑器（由 execViaHelper.js 启动）。
//
// 背景：主进程的 V8 虚拟地址空间可达 20GB 以上，Linux fork 时复制页表会偶发
// 阻塞整秒（实测 p90≈2s），而每个 SSH 采集命令都是一次 fork。这个辅助进程
// 启动后 VSZ 只有几百 MB，fork 稳定在毫秒级，主进程因此不再被阻塞。
//
// 协议：stdin 每行一个 JSON 请求，stdout 每行一个 JSON 响应。
const { execFile } = require("child_process");
const readline = require("readline");

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const { id, file, args, env, timeoutMs, maxBuffer, input } = req;
  const done = (err, stdout, stderr) => {
    process.stdout.write(
      JSON.stringify({
        id,
        errCode: err ? (err.code ?? 1) : 0,
        signal: err?.signal ?? null,
        killed: Boolean(err?.killed),
        message: err?.message ?? null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      }) + "\n"
    );
  };
  let child;
  try {
    child = execFile(
      file,
      args || [],
      { timeout: timeoutMs, env, maxBuffer, encoding: "utf8" },
      done
    );
  } catch (err) {
    done(err, "", "");
    return;
  }
  // 始终关闭 stdin：远端命令不需要它，Windows/PowerShell 反而会等它关闭。
  child.stdin?.on("error", () => {});
  child.stdin?.end(typeof input === "string" ? input : undefined);
});

rl.on("close", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));