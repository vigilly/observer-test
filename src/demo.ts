import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { compress as snappyCompress } from "snappyjs";
import { encodePrometheusWriteRequest } from "./proto.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const protoDir = fileURLToPath(new URL("../proto", import.meta.url));
const SERVICE_FILES = [
  "opentelemetry/proto/collector/trace/v1/trace_service.proto",
  "opentelemetry/proto/collector/logs/v1/logs_service.proto",
  "opentelemetry/proto/collector/metrics/v1/metrics_service.proto",
];

export interface DemoOptions {
  endpoint: string; // main HTTP (OTLP/HTTP, Sentry, Prometheus RW)
  grpcEndpoint: string; // host:port for OTLP/gRPC
  ddEndpoint: string; // Datadog intake
  grpc: boolean;
}

// --- value helpers for OTLP ---
const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });
const dv = (n: number) => ({ doubleValue: n });
const attr = (k: string, v: any) => ({ key: k, value: v });
const nowNs = () => String(BigInt(Date.now()) * 1_000_000n);
const svcAttr = () => attr("service.name", sv("demo-service"));

type IdMode = "hex" | "bytes";
const mkId = (mode: IdMode, bytes: number) =>
  mode === "hex" ? crypto.randomBytes(bytes).toString("hex") : crypto.randomBytes(bytes);

function buildLogs() {
  const t = nowNs();
  return {
    resourceLogs: [
      {
        resource: { attributes: [svcAttr()] },
        scopeLogs: [
          {
            scope: { name: "demo" },
            logRecords: [
              { timeUnixNano: t, severityNumber: 9, severityText: "INFO", body: sv("User u_123 signed in"), attributes: [attr("user.id", sv("u_123"))] },
              { timeUnixNano: t, severityNumber: 13, severityText: "WARN", body: sv("Cache miss for key=session:42"), attributes: [attr("cache.key", sv("session:42"))] },
            ],
          },
        ],
      },
    ],
  };
}

function buildTraces(mode: IdMode) {
  const traceId = mkId(mode, 16);
  const root = mkId(mode, 8);
  const child = mkId(mode, 8);
  const end = nowNs();
  const start = String(BigInt(end) - 42_000_000n);
  const cStart = String(BigInt(end) - 30_000_000n);
  return {
    resourceSpans: [
      {
        resource: { attributes: [svcAttr()] },
        scopeSpans: [
          {
            scope: { name: "demo" },
            spans: [
              {
                traceId, spanId: root, name: "GET /checkout", kind: 2,
                startTimeUnixNano: start, endTimeUnixNano: end, status: { code: 1 },
                attributes: [attr("http.method", sv("GET")), attr("http.route", sv("/checkout"))],
              },
              {
                traceId, spanId: child, parentSpanId: root, name: "db.query", kind: 3,
                startTimeUnixNano: cStart, endTimeUnixNano: end, status: { code: 2, message: "deadlock detected" },
                attributes: [attr("db.system", sv("postgres")), attr("db.statement", sv("SELECT * FROM cart"))],
                events: [
                  {
                    timeUnixNano: end, name: "exception",
                    attributes: [
                      attr("exception.type", sv("QueryError")),
                      attr("exception.message", sv("deadlock detected on relation cart")),
                      attr("exception.stacktrace", sv("at db.query (db.js:20)\\n  at handler (app.js:42)")),
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildMetrics() {
  const t = nowNs();
  return {
    resourceMetrics: [
      {
        resource: { attributes: [svcAttr()] },
        scopeMetrics: [
          {
            scope: { name: "demo" },
            metrics: [
              {
                name: "http.server.requests", unit: "1",
                sum: { isMonotonic: true, aggregationTemporality: 2, dataPoints: [{ asInt: iv(1421).intValue, timeUnixNano: t, attributes: [attr("http.status_code", iv(200))] }] },
              },
              {
                name: "process.memory.usage", unit: "By",
                gauge: { dataPoints: [{ asDouble: dv(5.31e8).doubleValue, timeUnixNano: t }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

async function postJson(url: string, body: unknown, contentType = "application/json"): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": contentType }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
}

// --- senders ---

async function sendOtlpHttp(base: string): Promise<void> {
  await postJson(`${base}/v1/logs`, buildLogs());
  await postJson(`${base}/v1/traces`, buildTraces("hex"));
  await postJson(`${base}/v1/metrics`, buildMetrics());
}

function grpcClients(endpoint: string) {
  const def = protoLoader.loadSync(SERVICE_FILES, {
    keepCase: false, longs: String, enums: Number, defaults: true, oneofs: true, includeDirs: [protoDir],
  });
  const pkg: any = grpc.loadPackageDefinition(def);
  const creds = grpc.credentials.createInsecure();
  return {
    traces: new pkg.opentelemetry.proto.collector.trace.v1.TraceService(endpoint, creds),
    logs: new pkg.opentelemetry.proto.collector.logs.v1.LogsService(endpoint, creds),
    metrics: new pkg.opentelemetry.proto.collector.metrics.v1.MetricsService(endpoint, creds),
  };
}

function grpcExport(client: any, payload: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    client.Export(payload, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

async function sendOtlpGrpc(endpoint: string): Promise<void> {
  const c = grpcClients(endpoint);
  await grpcExport(c.logs, buildLogs());
  await grpcExport(c.traces, buildTraces("bytes"));
  await grpcExport(c.metrics, buildMetrics());
}

async function sendSentry(base: string): Promise<void> {
  const eventId = crypto.randomBytes(16).toString("hex");
  const header = { event_id: eventId, sent_at: new Date().toISOString(), dsn: `${base}/demo-service` };
  const itemHeader = { type: "event" };
  const payload = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "node",
    level: "error",
    server_name: "demo-service",
    environment: "production",
    release: "demo@1.0.0",
    exception: {
      values: [
        {
          type: "TypeError",
          value: "Cannot read properties of undefined (reading 'id')",
          stacktrace: { frames: [
            { filename: "router.js", function: "dispatch", lineno: 88, colno: 12 },
            { filename: "app.js", function: "handler", lineno: 42, colno: 15 },
          ] },
        },
      ],
    },
    breadcrumbs: { values: [
      { category: "http", message: "GET /api/user", level: "info" },
      { category: "auth", message: "token refreshed", level: "debug" },
    ] },
    tags: { region: "eu-west-1" },
    user: { id: "u_123", email: "demo@example.com" },
  };
  const envelope = `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(payload)}\n`;
  const res = await fetch(`${base}/api/observe/demo-service/envelope/`, {
    method: "POST",
    headers: { "content-type": "application/x-sentry-envelope" },
    body: envelope,
  });
  if (!res.ok) throw new Error(`sentry -> HTTP ${res.status}`);
}

async function sendDatadog(base: string): Promise<void> {
  await postJson(`${base}/api/v2/logs`, [
    { message: "payment processed for order o_555", service: "demo-service", ddsource: "nodejs", ddtags: "env:prod,service:demo-service", hostname: "host-1", status: "info", timestamp: Date.now() },
  ]);
  await postJson(`${base}/api/v1/series`, {
    series: [{ metric: "demo.orders.count", points: [[Math.floor(Date.now() / 1000), 7]], type: "count", tags: ["env:prod", "service:demo-service"], host: "host-1" }],
  });
  // APM traces via msgpack v0.4 (PUT /v0.4/traces)
  const start = BigInt(Date.now()) * 1_000_000n;
  const trace = [
    { trace_id: 1234567890, span_id: 987654321, parent_id: 0, name: "web.request", resource: "GET /orders", service: "demo-service", type: "web", start, duration: 12_000_000n, error: 0, meta: { "http.method": "GET" }, metrics: { "_sampling_priority_v1": 1 } },
    { trace_id: 1234567890, span_id: 111222333, parent_id: 987654321, name: "pg.query", resource: "SELECT orders", service: "demo-db", type: "sql", start, duration: 5_000_000n, error: 1, meta: { "error.type": "PgError", "error.msg": "connection reset by peer", "error.stack": "at Connection.query (pg.js:210)" } },
  ];
  const body = msgpackEncode([trace], { useBigInt64: true });
  const res = await fetch(`${base}/v0.4/traces`, {
    method: "PUT",
    headers: { "content-type": "application/msgpack" },
    body: Buffer.from(body),
  });
  if (!res.ok) throw new Error(`datadog traces -> HTTP ${res.status}`);
}

async function sendPrometheus(base: string): Promise<void> {
  const encoded = await encodePrometheusWriteRequest({
    timeseries: [
      {
        labels: [
          { name: "__name__", value: "demo_queue_depth" },
          { name: "job", value: "demo-service" },
          { name: "instance", value: "host-1:9090" },
        ],
        samples: [{ value: 42, timestamp: Date.now() }],
      },
    ],
  });
  const compressed = Buffer.from(snappyCompress(encoded));
  const res = await fetch(`${base}/api/v1/write`, {
    method: "POST",
    headers: { "content-type": "application/x-protobuf", "content-encoding": "snappy" },
    body: compressed,
  });
  if (!res.ok) throw new Error(`prometheus -> HTTP ${res.status}`);
}

export async function runDemo(opts: DemoOptions): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ["Sentry exception envelope", () => sendSentry(opts.endpoint)],
    ["OTLP/HTTP logs + trace + metrics", () => sendOtlpHttp(opts.endpoint)],
    ["Datadog logs + series + APM trace", () => sendDatadog(opts.ddEndpoint)],
    ["Prometheus remote-write", () => sendPrometheus(opts.endpoint)],
  ];
  if (opts.grpc) steps.push(["OTLP/gRPC logs + trace + metrics", () => sendOtlpGrpc(opts.grpcEndpoint)]);

  let ok = 0;
  for (const [label, fn] of steps) {
    try {
      await fn();
      console.log(`  ✓ ${label}`);
      ok++;
    } catch (err) {
      console.log(`  ✗ ${label} — ${(err as Error).message}`);
    }
  }
  console.log(`\nSent ${ok}/${steps.length} sample payloads to the observer.`);
}
