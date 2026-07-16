// End-to-end smoke test for CI: start the collector, emit demo telemetry over
// every protocol, and assert the events were received. Node built-ins only.
import { spawn } from "node:child_process";

const BASE = "http://127.0.0.1:4318";
const children = [];

function run(args) {
  const child = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  return child;
}

function cleanup() {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {}
  }
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("collector did not become ready in time");
}

async function collectEvents(ms = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const events = [];
  try {
    const res = await fetch(`${BASE}/events`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith("data: ")) {
          try {
            events.push(JSON.parse(line.slice(6)));
          } catch {}
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
  return events;
}

function runDemo() {
  return new Promise((resolve, reject) => {
    const demo = run(["dist/cli.js", "demo"]);
    let out = "";
    demo.stdout.on("data", (d) => (out += d));
    demo.stderr.on("data", (d) => (out += d));
    demo.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`demo exited ${code}: ${out}`))));
  });
}

async function main() {
  const server = run(["dist/cli.js", "--host", "127.0.0.1"]);
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  await waitForReady();
  await runDemo();
  await new Promise((r) => setTimeout(r, 300));
  const events = await collectEvents();

  const signals = new Set(events.map((e) => e.signal));
  const sources = new Set(events.map((e) => e.source));
  const expectSignals = ["log", "trace", "exception", "metric"];
  const expectSources = ["sentry", "otlp", "datadog", "prometheus"];

  const missingSignals = expectSignals.filter((s) => !signals.has(s));
  const missingSources = expectSources.filter((s) => !sources.has(s));

  console.log(`received ${events.length} events`);
  console.log(`signals: ${[...signals].sort().join(", ")}`);
  console.log(`sources: ${[...sources].sort().join(", ")}`);

  if (events.length === 0) throw new Error("no events received");
  if (missingSignals.length) throw new Error(`missing signals: ${missingSignals.join(", ")}`);
  if (missingSources.length) throw new Error(`missing sources: ${missingSources.join(", ")}`);

  console.log("✓ smoke test passed");
}

main()
  .then(() => {
    cleanup();
    process.exit(0);
  })
  .catch((err) => {
    console.error(`✗ smoke test failed: ${err.message}`);
    cleanup();
    process.exit(1);
  });
