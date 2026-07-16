import * as http from "node:http";
import * as zlib from "node:zlib";
import { uncompress as snappyUncompress } from "snappyjs";
import type { EventStore, TelemetryEvent } from "./model.js";
import { INDEX_HTML } from "./ui.js";
import { sentryEnvelopeToEvents } from "./ingest/sentry.js";
import { otlpToEvents } from "./ingest/otlp.js";
import {
  datadogLogsToEvents,
  datadogMetricsToEvents,
  datadogTracesToEvents,
} from "./ingest/datadog.js";
import { prometheusRemoteWriteToEvents } from "./ingest/prometheus.js";
import { decodeOtlp, decodePrometheusWriteRequest, type OtlpKind } from "./proto.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_BODY = 32 * 1024 * 1024; // 32 MiB

const SENTRY_ENVELOPE = /^\/api\/(?:observe\/)?([^/]+)\/envelope\/?$/;
const DD_TRACES = /^\/v0\.[345]\/traces$/;
const DD_INPUT = /^\/v1\/input(?:\/.*)?$/;

/** Convert bigint/bytes to friendly JSON when streaming events to the browser. */
function eventReplacer(this: any, key: string, value: any): any {
  const orig = this[key];
  if (orig instanceof Uint8Array) return Buffer.from(orig).toString("hex");
  if (typeof orig === "bigint") return orig.toString();
  return value;
}

function serializeEvent(ev: TelemetryEvent): string {
  return JSON.stringify(ev, eventReplacer);
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function decompress(buf: Buffer, encoding?: string): Buffer {
  const enc = (encoding ?? "").toLowerCase();
  if (!buf.length) return buf;
  if (enc.includes("gzip")) return zlib.gunzipSync(buf);
  if (enc.includes("br")) return zlib.brotliDecompressSync(buf);
  if (enc.includes("deflate")) {
    try {
      return zlib.inflateSync(buf);
    } catch {
      return zlib.inflateRawSync(buf);
    }
  }
  if (enc.includes("snappy")) return Buffer.from(snappyUncompress(buf));
  return buf;
}

function setCors(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("access-control-allow-headers", "*");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? {});
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

/** Runtime info shown in the UI header (served at GET /config). */
export interface ServerMeta {
  httpPort?: number;
  grpcPort?: number;
  ddPort?: number;
  scrape?: string[];
}

/**
 * Build the shared request handler. The same handler is used for the main
 * listener and the Datadog agent-port listener.
 */
export function createHttpServer(store: EventStore, meta: ServerMeta = {}): http.Server {
  const server = http.createServer((req, res) => {
    handle(store, meta, req, res).catch((err) => {
      console.error("[http] handler error:", err);
      if (!res.headersSent) sendJson(res, 200, {}); // never make an exporter retry
    });
  });
  // SSE connections are long-lived; don't let Node time them out.
  server.timeout = 0;
  server.keepAliveTimeout = 0;
  return server;
}

async function handle(
  store: EventStore,
  meta: ServerMeta,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  setCors(res);
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- UI + control plane ---
  if (method === "GET" && (path === "/" || path === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }
  if (method === "GET" && path === "/events") {
    streamEvents(store, req, res);
    return;
  }
  if (method === "GET" && path === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "GET" && path === "/config") {
    sendJson(res, 200, meta);
    return;
  }
  if (path === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }
  // Datadog agent info — lets DD tracers negotiate the trace endpoint.
  if (method === "GET" && path === "/info") {
    sendJson(res, 200, {
      version: "vigilly-observer",
      endpoints: ["/v0.3/traces", "/v0.4/traces", "/v0.5/traces", "/api/v1/series", "/api/v2/series"],
      client_drop_p0s: false,
    });
    return;
  }

  // --- ingest (all POST/PUT with a body) ---
  const encoding = req.headers["content-encoding"] as string | undefined;
  const contentType = (req.headers["content-type"] as string | undefined) ?? "";

  // Sentry envelope (the @vigilly/* SDK tunnel target)
  const sentryMatch = SENTRY_ENVELOPE.exec(path);
  if (method === "POST" && sentryMatch) {
    const body = decompress(await readBody(req), encoding);
    store.addMany(sentryEnvelopeToEvents(body, decodeURIComponent(sentryMatch[1])));
    sendJson(res, 200, {});
    return;
  }

  // OTLP/HTTP
  if (method === "POST" && (path === "/v1/traces" || path === "/v1/logs" || path === "/v1/metrics")) {
    const kind: OtlpKind = path === "/v1/traces" ? "traces" : path === "/v1/logs" ? "logs" : "metrics";
    const body = decompress(await readBody(req), encoding);
    const payload = contentType.includes("json")
      ? JSON.parse(body.toString("utf8"))
      : await decodeOtlp(kind, body);
    store.addMany(otlpToEvents(kind, payload));
    sendJson(res, 200, {});
    return;
  }

  // Datadog logs
  if (method === "POST" && (path === "/api/v2/logs" || DD_INPUT.test(path))) {
    const body = decompress(await readBody(req), encoding);
    store.addMany(datadogLogsToEvents(JSON.parse(body.toString("utf8") || "[]")));
    sendJson(res, 202, {});
    return;
  }

  // Datadog metrics
  if (method === "POST" && (path === "/api/v1/series" || path === "/api/v2/series")) {
    const body = decompress(await readBody(req), encoding);
    store.addMany(datadogMetricsToEvents(JSON.parse(body.toString("utf8") || "{}")));
    sendJson(res, 202, { status: "ok" });
    return;
  }

  // Datadog APM traces
  if ((method === "PUT" || method === "POST") && DD_TRACES.test(path)) {
    const body = decompress(await readBody(req), encoding);
    if (body.length) store.addMany(datadogTracesToEvents(body, contentType));
    sendJson(res, 200, { rate_by_service: {} });
    return;
  }

  // Prometheus remote-write
  if (method === "POST" && path === "/api/v1/write") {
    const raw = await readBody(req);
    const body = decompress(raw, encoding || "snappy");
    const decoded = await decodePrometheusWriteRequest(body);
    store.addMany(prometheusRemoteWriteToEvents(decoded));
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found", path }));
}

function streamEvents(store: EventStore, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  res.write("retry: 2000\n\n");

  // Snapshot of recent events so a fresh browser isn't empty.
  for (const ev of store.snapshot()) res.write(`data: ${serializeEvent(ev)}\n\n`);

  const onEvent = (ev: TelemetryEvent) => res.write(`data: ${serializeEvent(ev)}\n\n`);
  store.on("event", onEvent);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);

  const cleanup = () => {
    clearInterval(heartbeat);
    store.off("event", onEvent);
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
}
