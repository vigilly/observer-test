import { EventEmitter } from "node:events";

/** The four telemetry signals we surface in the UI. */
export type Signal = "log" | "trace" | "exception" | "metric";

/** Which wire protocol / product an event arrived on. */
export type Source = "sentry" | "otlp" | "datadog" | "prometheus";

/**
 * A single normalized telemetry event. Every ingester converts whatever it
 * received into one or more of these so the UI can treat them uniformly.
 */
export interface TelemetryEvent {
  /** Monotonic id assigned on receive — ordering is independent of clocks. */
  id: number;
  /** Server receive time (epoch ms). */
  receivedAt: number;
  /** The event's own timestamp if the payload carried one (epoch ms). */
  timestamp?: number;
  source: Source;
  signal: Signal;
  /** service.name / DD service / Sentry server_name|env|release / prom job. */
  service?: string;
  /** One-line human summary shown in the stream row. */
  summary: string;
  /** Flattened, display-friendly attributes (severity, duration, labels, ...). */
  attributes?: Record<string, unknown>;
  /** Full decoded payload for the expandable detail view. */
  raw?: unknown;
}

/** Fields an ingester provides; id/receivedAt are filled in by the store. */
export type IncomingEvent = Omit<TelemetryEvent, "id" | "receivedAt">;

/**
 * In-memory store: a bounded ring buffer of recent events plus an event bus.
 * New browsers get a snapshot of the buffer, then live updates via SSE.
 */
export class EventStore extends EventEmitter {
  private readonly buffer: TelemetryEvent[] = [];
  private nextId = 1;

  constructor(private readonly max: number = 1000) {
    super();
    // Many SSE clients may listen at once; avoid the default 10-listener warning.
    this.setMaxListeners(0);
  }

  /** Normalize, store, and broadcast one event. Returns the stored event. */
  add(incoming: IncomingEvent): TelemetryEvent {
    const event: TelemetryEvent = {
      ...incoming,
      id: this.nextId++,
      receivedAt: Date.now(),
    };
    this.buffer.push(event);
    if (this.buffer.length > this.max) this.buffer.shift();
    this.emit("event", event);
    return event;
  }

  /** Convenience for ingesters that produce several events from one payload. */
  addMany(events: IncomingEvent[]): TelemetryEvent[] {
    return events.map((e) => this.add(e));
  }

  /** Current buffered events (oldest first) for a snapshot on connect. */
  snapshot(): TelemetryEvent[] {
    return this.buffer.slice();
  }

  /** Drop all buffered events (backs the UI "Clear" button via POST /clear). */
  clear(): void {
    this.buffer.length = 0;
  }
}
