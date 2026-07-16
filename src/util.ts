/** Small display helpers shared across ingesters. */

/** Human-friendly duration from milliseconds. */
export function formatDuration(ms: number): string {
  if (!isFinite(ms)) return "?";
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Compact number formatting for metric values. */
export function formatNumber(n: number): string {
  if (!isFinite(n)) return String(n);
  if (Number.isInteger(n)) return n.toString();
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-3 || abs >= 1e6)) return n.toExponential(2);
  return Number(n.toFixed(4)).toString();
}

/** Clamp a string for one-line summaries. */
export function truncate(s: string, max = 200): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

/** Hex-encode an id that may arrive as bytes (protobuf) or a hex/base64 string (JSON). */
export function toHex(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (Array.isArray(v)) return Buffer.from(v as number[]).toString("hex");
  if (typeof v === "string") {
    if (v === "") return undefined;
    if (/^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) return v.toLowerCase();
    try {
      return Buffer.from(v, "base64").toString("hex");
    } catch {
      return v;
    }
  }
  return String(v);
}

/** Convert a possibly-huge nanosecond value (string|number|bigint) to epoch ms. */
export function nanosToMs(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  try {
    const big = typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.trunc(v) : (v as string));
    return Number(big / 1_000_000n);
  } catch {
    const n = Number(v);
    return isFinite(n) ? Math.floor(n / 1e6) : undefined;
  }
}
