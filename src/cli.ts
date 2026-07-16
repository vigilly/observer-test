#!/usr/bin/env node
import * as http from "node:http";
import { parseArgs } from "node:util";
import { EventStore } from "./model.js";
import { createHttpServer, type ServerMeta } from "./server.js";
import { startGrpcServer, type GrpcHandle } from "./grpc/server.js";
import { startScraper, type ScrapeHandle } from "./scrape/prometheus.js";
import { preloadProtos } from "./proto.js";
import { runDemo } from "./demo.js";

const HELP = `vigilly-observer — live telemetry viewer for vigilly-instrumented apps

USAGE
  vigilly-observer [options]        start the collector + web UI
  vigilly-observer demo [options]   emit sample telemetry to a running collector

SERVE OPTIONS
  --port <n>            main HTTP port: web UI, OTLP/HTTP, Sentry, Datadog, Prom RW  (default 4318)
  --grpc-port <n>      OTLP/gRPC port                                               (default 4317)
  --dd-port <n>        Datadog agent port (APM traces / logs / metrics)             (default 8126)
  --host <addr>        bind address                                                 (default 127.0.0.1)
  --no-grpc            disable the OTLP/gRPC listener
  --no-datadog         disable the dedicated Datadog agent-port listener
  --scrape <urls>      comma-separated Prometheus /metrics URLs to scrape
  --scrape-interval <s> scrape interval in seconds                                  (default 10)
  --max <n>            max events kept in memory                                     (default 1000)

DEMO OPTIONS
  --endpoint <url>      main HTTP endpoint          (default http://localhost:<port>)
  --grpc-endpoint <hp>  OTLP/gRPC host:port         (default localhost:<grpc-port>)
  --dd-endpoint <url>   Datadog endpoint            (default the main endpoint)

  -h, --help           show this help
`;

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return v != null && Number.isFinite(n) ? n : def;
}

function listen(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" },
    "grpc-port": { type: "string" },
    "dd-port": { type: "string" },
    host: { type: "string" },
    "no-grpc": { type: "boolean" },
    "no-datadog": { type: "boolean" },
    scrape: { type: "string" },
    "scrape-interval": { type: "string" },
    max: { type: "string" },
    endpoint: { type: "string" },
    "grpc-endpoint": { type: "string" },
    "dd-endpoint": { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const port = num(values.port, 4318);
const grpcPort = num(values["grpc-port"], 4317);
const ddPort = num(values["dd-port"], 8126);
const host = values.host ?? "127.0.0.1";
const uiHost = host === "0.0.0.0" || host === "::" ? "localhost" : host;

if (positionals[0] === "demo") {
  const endpoint = values.endpoint ?? `http://${uiHost}:${port}`;
  await runDemo({
    endpoint: endpoint.replace(/\/$/, ""),
    grpcEndpoint: values["grpc-endpoint"] ?? `${uiHost}:${grpcPort}`,
    ddEndpoint: (values["dd-endpoint"] ?? endpoint).replace(/\/$/, ""),
    grpc: !values["no-grpc"],
  });
  process.exit(0);
}

// ---- serve ----
const enableGrpc = !values["no-grpc"];
const enableDd = !values["no-datadog"];
const bindDdListener = enableDd && ddPort !== port;
const scrapeTargets = (values.scrape ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const scrapeInterval = num(values["scrape-interval"], 10) * 1000;

const store = new EventStore(num(values.max, 1000));
await preloadProtos();

const meta: ServerMeta = {
  httpPort: port,
  grpcPort: enableGrpc ? grpcPort : undefined,
  ddPort: bindDdListener ? ddPort : undefined,
  scrape: scrapeTargets,
};

const mainServer = createHttpServer(store, meta);
await listen(mainServer, host, port);

let ddServer: http.Server | undefined;
if (bindDdListener) {
  ddServer = createHttpServer(store, meta);
  try {
    await listen(ddServer, host, ddPort);
  } catch (err) {
    console.warn(`⚠ could not bind Datadog agent port ${ddPort}: ${(err as Error).message} (Datadog intake still works on :${port})`);
    ddServer = undefined;
    meta.ddPort = undefined;
  }
}

let grpcHandle: GrpcHandle | undefined;
if (enableGrpc) {
  try {
    grpcHandle = await startGrpcServer(store, host, grpcPort);
  } catch (err) {
    console.warn(`⚠ could not start OTLP/gRPC on ${grpcPort}: ${(err as Error).message}`);
    meta.grpcPort = undefined;
  }
}

let scraper: ScrapeHandle | undefined;
if (scrapeTargets.length) {
  scraper = startScraper(store, scrapeTargets, scrapeInterval);
}

printBanner();

function printBanner(): void {
  const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const lines: string[] = [];
  lines.push("");
  lines.push(b("  ◉ vigilly observer") + dim("  — live telemetry viewer"));
  lines.push("");
  lines.push(`  Web UI          ${cyan(`http://${uiHost}:${port}`)}`);
  lines.push(`  OTLP/HTTP       http://${uiHost}:${port}    ${dim("(traces · logs · metrics; JSON or protobuf)")}`);
  if (grpcHandle) lines.push(`  OTLP/gRPC       ${uiHost}:${grpcPort}${" ".repeat(Math.max(1, 9 - String(grpcPort).length))}${dim("(traces · logs · metrics)")}`);
  lines.push(`  Sentry / vigilly  http://${uiHost}:${port}/api/observe/<projectId>/envelope/`);
  lines.push(`  Datadog         http://${uiHost}:${port}${ddServer ? ` and :${ddPort}` : ""}    ${dim("(logs · series · APM traces)")}`);
  lines.push(`  Prometheus RW   http://${uiHost}:${port}/api/v1/write`);
  if (scraper) lines.push(`  Prometheus scrape  ${scrapeTargets.join(", ")}  ${dim(`every ${scrapeInterval / 1000}s`)}`);
  lines.push("");
  lines.push(dim("  Point your app here:"));
  lines.push(`    vigilly:     ${cyan(`Vigilly.init({ dsn: "http://public@${uiHost}:${port}/<projectId>" })`)}`);
  lines.push(`    OTLP:        ${cyan(`OTEL_EXPORTER_OTLP_ENDPOINT=http://${uiHost}:${port}`)}`);
  if (grpcHandle) lines.push(dim(`                 (add OTEL_EXPORTER_OTLP_PROTOCOL=grpc + port ${grpcPort} for gRPC)`));
  lines.push(`    Datadog:     ${cyan(`DD_TRACE_AGENT_URL=http://${uiHost}:${ddServer ? ddPort : port}`)}`);
  lines.push("");
  lines.push(dim(`  No app yet? Run  `) + cyan("vigilly-observer demo") + dim("  to see sample data."));
  lines.push("");
  console.log(lines.join("\n"));
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  scraper?.stop();
  await Promise.allSettled([
    new Promise<void>((r) => mainServer.close(() => r())),
    ddServer ? new Promise<void>((r) => ddServer!.close(() => r())) : Promise.resolve(),
    grpcHandle ? grpcHandle.close() : Promise.resolve(),
  ]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
