import { chainById } from "../config/explorer";

export function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function truncateMiddle(value: string, start = 8, end = 6) {
  if (value.length <= start + end + 3) {
    return value;
  }

  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

export function formatRequestIdCompact(requestId: string) {
  const normalized = requestId.startsWith("0x") ? requestId : `0x${requestId}`;
  const raw = normalized.slice(2).toLowerCase();
  const trimmed = raw.replace(/^0+/, "") || "0";
  const middle = trimmed.slice(0, 5);
  const tail = trimmed.slice(-2);

  if (trimmed.length <= 9) {
    return `0x0...${trimmed}`;
  }

  return `0x0...${middle}...${tail}`;
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatRelative(value: string) {
  const deltaMs = Date.now() - new Date(value).getTime();
  const minutes = Math.round(deltaMs / 60000);

  if (Math.abs(minutes) < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) {
    return `${hours}h ago`;
  }

  return `${Math.round(hours / 24)}d ago`;
}

export function hexToNumber(value: string) {
  return Number.parseInt(value, 16);
}

export function safeNumber(value: string | number | boolean | null | undefined) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) {
      return 0;
    }

    try {
      if (/^0x/i.test(normalized)) {
        return Number(BigInt(normalized));
      }

      const parsed = Number(normalized);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  return 0;
}

export function packChainLabel(chainId: number) {
  return chainById.get(chainId)?.shortName ?? `Chain ${chainId}`;
}

export function normalizeHex(value: string) {
  return value.toLowerCase();
}

export function padTopicValue(value: string) {
  return `0x${value.replace(/^0x/, "").padStart(64, "0")}`;
}

export function unpackRequestId(requestId: string) {
  const padded = requestId.replace(/^0x/, "").padStart(64, "0");
  const source = padded.slice(0, 32);
  const nonce = padded.slice(32);

  return {
    chainId: Number(BigInt(`0x${source}`)),
    nonce: Number(BigInt(`0x${nonce}`)),
  };
}

export async function copyToClipboard(value: string) {
  await navigator.clipboard.writeText(value);
}
