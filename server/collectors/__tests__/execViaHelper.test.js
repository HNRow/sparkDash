// exec helper：通过常驻小进程执行命令，避免主进程 fork 阻塞。
import test from "node:test";
import assert from "node:assert/strict";
import { execViaHelper, closeExecHelper } from "../execViaHelper.js";

test.after(() => closeExecHelper());

test("returns stdout and exit code", async () => {
  const res = await execViaHelper("sh", ["-c", "printf hello"]);
  assert.equal(res.errCode, 0);
  assert.equal(res.stdout, "hello");
});

test("reports a non-zero exit code", async () => {
  const res = await execViaHelper("sh", ["-c", "exit 7"]);
  assert.equal(res.errCode, 7);
});

test("kills on timeout", async () => {
  const res = await execViaHelper("sh", ["-c", "sleep 5"], { timeout: 300 });
  assert.ok(res.killed || res.signal, "command should be killed");
});

test("passes input on stdin", async () => {
  const res = await execViaHelper("sh", ["-c", "cat"], { input: "abc" });
  assert.equal(res.stdout, "abc");
});

test("missing binary reports a spawn error", async () => {
  const res = await execViaHelper("/nonexistent/binary", []);
  assert.ok(res.message, "should carry an error message");
});