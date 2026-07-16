import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import type { EventStore } from "../model.js";
import { otlpToEvents } from "../ingest/otlp.js";
import type { OtlpKind } from "../proto.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const protoDir = fileURLToPath(new URL("../../proto", import.meta.url));

const SERVICE_FILES = [
  "opentelemetry/proto/collector/trace/v1/trace_service.proto",
  "opentelemetry/proto/collector/logs/v1/logs_service.proto",
  "opentelemetry/proto/collector/metrics/v1/metrics_service.proto",
];

export interface GrpcHandle {
  port: number;
  close(): Promise<void>;
}

function loadServices(): any {
  const def = protoLoader.loadSync(SERVICE_FILES, {
    keepCase: false, // camelCase matches OTLP/JSON so `raw` reads cleanly in the UI
    longs: String,
    enums: Number,
    defaults: false, // omit zero-valued fields — keep decoded payloads faithful
    oneofs: false, // don't inject synthetic oneof marker fields
    includeDirs: [protoDir],
  });
  return grpc.loadPackageDefinition(def);
}

function makeHandler(kind: OtlpKind, store: EventStore) {
  return (call: any, callback: any) => {
    try {
      store.addMany(otlpToEvents(kind, call.request));
    } catch (err) {
      // Never fail the export because of a display-side parse issue.
      console.error(`[grpc] failed to ingest OTLP ${kind}:`, err);
    }
    callback(null, {}); // empty Export*ServiceResponse
  };
}

/** Start the OTLP/gRPC collector on host:port. */
export function startGrpcServer(store: EventStore, host: string, port: number): Promise<GrpcHandle> {
  const pkg = loadServices();
  const server = new grpc.Server();

  server.addService(pkg.opentelemetry.proto.collector.trace.v1.TraceService.service, {
    Export: makeHandler("traces", store),
  });
  server.addService(pkg.opentelemetry.proto.collector.logs.v1.LogsService.service, {
    Export: makeHandler("logs", store),
  });
  server.addService(pkg.opentelemetry.proto.collector.metrics.v1.MetricsService.service, {
    Export: makeHandler("metrics", store),
  });

  return new Promise<GrpcHandle>((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) return reject(err);
      resolve({
        port: boundPort,
        close: () =>
          new Promise<void>((res) => {
            const force = setTimeout(() => {
              server.forceShutdown();
              res();
            }, 1000);
            force.unref();
            server.tryShutdown(() => {
              clearTimeout(force);
              res();
            });
          }),
      });
    });
  });
}
