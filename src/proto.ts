import protobuf from "protobufjs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

/**
 * protobufjs loader for the vendored descriptors. Resolves the `proto/`
 * directory relative to this module so it works both from `dist/` and from
 * `src/` under tsx (both sit one level below the repo root).
 */
const protoDir = fileURLToPath(new URL("../proto", import.meta.url));

const ENTRY_FILES = [
  "opentelemetry/proto/collector/trace/v1/trace_service.proto",
  "opentelemetry/proto/collector/logs/v1/logs_service.proto",
  "opentelemetry/proto/collector/metrics/v1/metrics_service.proto",
  "prometheus/remote.proto",
];

let rootPromise: Promise<protobuf.Root> | null = null;

async function getRoot(): Promise<protobuf.Root> {
  if (!rootPromise) {
    const root = new protobuf.Root();
    // OTLP protos import each other by root-relative path
    // (e.g. "opentelemetry/proto/common/v1/common.proto"); resolve those and
    // the entry files against the vendored proto directory.
    root.resolvePath = (_origin, target) =>
      path.isAbsolute(target) ? target : path.join(protoDir, target);
    rootPromise = root.load(ENTRY_FILES);
  }
  return rootPromise;
}

/**
 * Conversion options that keep the decoded object close to the OTLP/JSON shape
 * our ingester expects: 64-bit ints (nanosecond timestamps) as strings, enums
 * as numbers, and repeated fields always present as arrays. Bytes fields
 * (trace/span ids) are left as Buffers and hex-encoded downstream.
 */
const TO_OBJECT_OPTS: protobuf.IConversionOptions = {
  longs: String,
  enums: Number,
  defaults: false,
  arrays: true,
  objects: true,
};

export type OtlpKind = "traces" | "logs" | "metrics";

const REQUEST_TYPE: Record<OtlpKind, string> = {
  traces: "opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest",
  logs: "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
  metrics: "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
};

/** Decode an OTLP/protobuf export request into a plain object. */
export async function decodeOtlp(
  kind: OtlpKind,
  buf: Buffer,
): Promise<Record<string, unknown>> {
  const root = await getRoot();
  const Type = root.lookupType(REQUEST_TYPE[kind]);
  const msg = Type.decode(buf);
  return Type.toObject(msg, TO_OBJECT_OPTS) as Record<string, unknown>;
}

/** Decode a Prometheus remote-write WriteRequest into a plain object. */
export async function decodePrometheusWriteRequest(
  buf: Buffer,
): Promise<Record<string, unknown>> {
  const root = await getRoot();
  const Type = root.lookupType("prometheus.WriteRequest");
  const msg = Type.decode(buf);
  return Type.toObject(msg, TO_OBJECT_OPTS) as Record<string, unknown>;
}

/** Encode a Prometheus WriteRequest object to protobuf bytes (used by the demo). */
export async function encodePrometheusWriteRequest(
  obj: Record<string, unknown>,
): Promise<Buffer> {
  const root = await getRoot();
  const Type = root.lookupType("prometheus.WriteRequest");
  const err = Type.verify(obj);
  if (err) throw new Error(`invalid WriteRequest: ${err}`);
  return Buffer.from(Type.encode(Type.fromObject(obj)).finish());
}

/** Warm the proto root at startup so first-request latency is low. */
export async function preloadProtos(): Promise<void> {
  await getRoot();
}
