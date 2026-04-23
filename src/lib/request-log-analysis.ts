import type { NormalizedRequest, TransactionLog } from "../types/explorer";
import { normalizeHex } from "./format";

export type LifecycleSegment = {
  txHash: string;
  logs: TransactionLog[];
  messageReceived: TransactionLog | null;
  validationsStarted: TransactionLog[];
  validationsSucceeded: TransactionLog[];
  validationsFailed: TransactionLog[];
  feeExecution: TransactionLog | null;
  errorReceived: TransactionLog | null;
  responseReceived: TransactionLog | null;
  raiseReceived: TransactionLog | null;
  outgoingMessages: TransactionLog[];
  incomingResponseReceived: TransactionLog | null;
  appLogs: TransactionLog[];
};

export type GeneratedResponseLink = {
  kind: "response" | "raise";
  triggerLog: TransactionLog;
  sentLog: TransactionLog | null;
  responseRequestId: string | null;
  responseRequest: NormalizedRequest | null;
};

export function eventName(log: TransactionLog) {
  return log.decoded?.method_call.split("(")[0] ?? "RawLog";
}

export function getParam(log: TransactionLog | null, name: string) {
  return log?.decoded?.parameters.find((parameter) => parameter.name === name)?.value;
}

export function getRequestIdFromLog(log: TransactionLog | null) {
  const value = getParam(log, "requestId");
  return typeof value === "string" ? value : null;
}

function sortLogs(logs: TransactionLog[]) {
  return [...logs].sort((left, right) => left.index - right.index);
}

export function summarizeSegment(
  requestId: string,
  logs: TransactionLog[],
  txHash: string,
): LifecycleSegment {
  const orderedLogs = sortLogs(logs);
  const requestStart = orderedLogs.findIndex(
    (log) =>
      eventName(log) === "MessageReceived" &&
      normalizeHex(getRequestIdFromLog(log) ?? "") === normalizeHex(requestId),
  );

  const nextStart =
    requestStart >= 0
      ? orderedLogs.findIndex(
          (log, index) => index > requestStart && eventName(log) === "MessageReceived",
        )
      : -1;

  const segmentLogs =
    requestStart >= 0
      ? orderedLogs.slice(requestStart, nextStart >= 0 ? nextStart : undefined)
      : [];

  const messageReceived =
    segmentLogs.find((log) => eventName(log) === "MessageReceived") ?? null;
  const validationsStarted = segmentLogs.filter(
    (log) => eventName(log) === "ValidateCiphertextStart",
  );
  const validationsSucceeded = segmentLogs.filter(
    (log) => eventName(log) === "ValidateCiphertextSuccess",
  );
  const validationsFailed = segmentLogs.filter(
    (log) => eventName(log) === "ValidateCiphertextFailed",
  );
  const feeExecution =
    segmentLogs.find(
      (log) =>
        eventName(log) === "FeeExecutionSettled" &&
        normalizeHex(getRequestIdFromLog(log) ?? "") === normalizeHex(requestId),
    ) ?? null;
  const errorReceived =
    segmentLogs.find(
      (log) =>
        eventName(log) === "ErrorReceived" &&
        normalizeHex(getRequestIdFromLog(log) ?? "") === normalizeHex(requestId),
    ) ?? null;
  const responseReceived =
    segmentLogs.find(
      (log) =>
        eventName(log) === "ResponseReceived" &&
        normalizeHex(getRequestIdFromLog(log) ?? "") === normalizeHex(requestId),
    ) ?? null;
  const raiseReceived =
    segmentLogs.find(
      (log) =>
        eventName(log) === "RaiseReceived" &&
        normalizeHex(getRequestIdFromLog(log) ?? "") === normalizeHex(requestId),
    ) ?? null;
  const outgoingMessages = segmentLogs.filter((log) => {
    if (eventName(log) !== "MessageSent") {
      return false;
    }

    const candidateRequestId = getRequestIdFromLog(log);
    return normalizeHex(candidateRequestId ?? "") !== normalizeHex(requestId);
  });
  const incomingResponseReceived =
    segmentLogs.find((log) => eventName(log) === "IncomingResponseReceived") ?? null;
  const appLogs = segmentLogs.filter(
    (log) =>
      ![
        "MessageReceived",
        "MessageSent",
        "ResponseReceived",
        "RaiseReceived",
        "IncomingResponseReceived",
        "ErrorReceived",
        "FeeExecutionSettled",
        "ValidateCiphertextStart",
        "ValidateCiphertextSuccess",
        "ValidateCiphertextFailed",
      ].includes(eventName(log)),
  );

  return {
    txHash,
    logs: segmentLogs,
    messageReceived,
    validationsStarted,
    validationsSucceeded,
    validationsFailed,
    feeExecution,
    errorReceived,
    responseReceived,
    raiseReceived,
    outgoingMessages,
    incomingResponseReceived,
    appLogs,
  };
}

export async function findGeneratedResponseLink(
  requestId: string,
  segment: LifecycleSegment | null,
  resolveRequest: (requestId: string) => Promise<NormalizedRequest | null>,
): Promise<GeneratedResponseLink | null> {
  if (!segment) {
    return null;
  }

  const triggerLog = segment.responseReceived ?? segment.raiseReceived;
  if (!triggerLog) {
    return null;
  }

  const kind = segment.responseReceived ? "response" : "raise";
  const outgoingMessages = sortLogs(segment.outgoingMessages);

  for (const sentLog of outgoingMessages) {
    const candidateRequestId = getRequestIdFromLog(sentLog);
    if (!candidateRequestId) {
      continue;
    }

    const responseRequest = await resolveRequest(candidateRequestId);
    if (
      responseRequest &&
      normalizeHex(responseRequest.sourceRequestId ?? "") === normalizeHex(requestId)
    ) {
      return {
        kind,
        triggerLog,
        sentLog,
        responseRequestId: candidateRequestId,
        responseRequest,
      };
    }
  }

  return {
    kind,
    triggerLog,
    sentLog: outgoingMessages[0] ?? null,
    responseRequestId: null,
    responseRequest: null,
  };
}
