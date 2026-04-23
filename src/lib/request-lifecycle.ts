import { chainById, chainConfigs } from "../config/explorer";
import {
  EVENT_TOPICS,
  fetchInboxEventByRequestId,
  fetchTransactionLogs,
  resolveRequestById,
} from "./api";
import { formatRequestIdCompact, safeNumber, truncateMiddle } from "./format";
import {
  eventName,
  findGeneratedResponseLink,
  getParam,
  summarizeSegment,
  type LifecycleSegment,
} from "./request-log-analysis";
import type {
  ChainConfig,
  NormalizedRequest,
} from "../types/explorer";

export type StageStatus = "success" | "failed" | "pending" | "neutral" | "skipped";

export type LifecycleStage = {
  key: string;
  step: string;
  title: string;
  status: StageStatus;
  chain: ChainConfig | null;
  txHash: string | null;
  note: string;
  details: string[];
  requestId?: string | null;
};

export type RequestLifecycle = {
  request: NormalizedRequest;
  originChain: ChainConfig | null;
  targetChain: ChainConfig | null;
  parentRequestId: string | null;
  parentRequest: NormalizedRequest | null;
  sentLog: {
    chain: ChainConfig;
    txHash: string;
  } | null;
  receivedLog: {
    chain: ChainConfig;
    txHash: string;
  } | null;
  requestSegment: LifecycleSegment | null;
  outcome:
    | "response"
    | "raised_error"
    | "one_way_complete"
    | "execution_failed"
    | "unknown";
  childRequestId: string | null;
  childRequest: NormalizedRequest | null;
  childReceivedLog: {
    chain: ChainConfig;
    txHash: string;
  } | null;
  childSegment: LifecycleSegment | null;
  incomingResponseLog: {
    chain: ChainConfig;
    txHash: string;
    sourceRequestId: string | null;
  } | null;
  errors: Array<{
    requestId: string;
    phase: string;
    code: number | null;
    codeLabel: string;
    description: string;
    raw: string;
    selector: string | null;
    details: string[];
  }>;
  stages: LifecycleStage[];
};

type DecodedErrorPayload = {
  description: string;
  selector: string | null;
  details: string[];
};

function decodeErrorCode(code: number | null, phase: string) {
  if (code === null) {
    return "Unknown inbox error";
  }

  if (code === 1) {
    return phase === "Return-leg execution"
      ? "Response execution failed"
      : "Execution failed";
  }

  if (code === 2) {
    return "Encode failed";
  }

  return `Inbox error code ${code}`;
}

function classifyErrorPhase(
  errorCode: number | null,
  segment: LifecycleSegment | null,
  fallback: string,
) {
  if (errorCode === 1) {
    return "Remote execution";
  }

  if (errorCode === 2) {
    return "Encoding / calldata preparation";
  }

  if (segment?.feeExecution === null) {
    return fallback;
  }

  return "Remote execution";
}

function decodeErrorData(raw: string): DecodedErrorPayload {
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (normalized === "0x" || normalized === "0x0") {
    return {
      description: "Execution reverted without an error payload.",
      selector: null,
      details: [],
    };
  }

  const selector = normalized.slice(0, 10).toLowerCase();

  if (selector === "0x08c379a0" && normalized.length >= 138) {
    try {
      const lengthHex = normalized.slice(138, 202);
      const length = Number(BigInt(`0x${lengthHex}`));
      const dataHex = normalized.slice(202, 202 + length * 2);
      const bytes = new Uint8Array(
        dataHex.match(/.{1,2}/g)?.map((chunk) => Number.parseInt(chunk, 16)) ?? [],
      );
      const text = new TextDecoder().decode(bytes);
      return {
        description: `Error(string): ${text}`,
        selector,
        details: [`Decoded revert string: ${text}`],
      };
    } catch {
      return {
        description: "Error(string) revert payload.",
        selector,
        details: [],
      };
    }
  }

  if (selector === "0x4e487b71" && normalized.length >= 138) {
    const code = Number(BigInt(`0x${normalized.slice(74, 138)}`));
    const panicLabels: Record<number, string> = {
      1: "Assertion failed",
      17: "Arithmetic overflow/underflow",
      18: "Division by zero",
      33: "Invalid enum conversion",
      34: "Invalid storage byte array encoding",
      49: "Pop on empty array",
      50: "Array out-of-bounds",
      65: "Out-of-memory",
      81: "Called uninitialized internal function",
    };

    return {
      description: `Panic(${code}): ${panicLabels[code] ?? "Solidity panic"}`,
      selector,
      details: [`Solidity panic code: ${code}`],
    };
  }

  if (normalized.length >= 10 && (normalized.length - 10) % 64 === 0) {
    const words: string[] = [];
    for (let index = 10; index < normalized.length; index += 64) {
      words.push(`0x${normalized.slice(index, index + 64)}`);
    }

    return {
      description: `Custom error payload (${selector})`,
      selector,
      details: words.map((word, index) => `Argument ${index + 1}: ${word}`),
    };
  }

  return {
    description: `Non-standard runtime payload: ${truncateMiddle(normalized, 18, 12)}`,
    selector: normalized.length >= 10 ? selector : null,
    details: [],
  };
}

async function inferObservedChains(request: NormalizedRequest) {
  const knownOrigin = chainById.get(request.sourceChainId) ?? null;
  const knownTarget = chainById.get(request.targetChainId) ?? null;

  if (knownOrigin && knownTarget) {
    return {
      originChain: knownOrigin,
      targetChain: knownTarget,
    };
  }

  const matches = (
    await Promise.all(
      chainConfigs.map(async (chain) => {
        try {
          const log = await fetchInboxEventByRequestId(
            chain,
            EVENT_TOPICS.messageReceived,
            request.requestId,
          );

          if (!log) {
            return null;
          }

          return {
            chain,
            log,
            sourceChainId: safeNumber(log.topics[2] ?? "0x0"),
          };
        } catch {
          return null;
        }
      }),
    )
  ).flatMap((match) => (match ? [match] : []));

  const creationMatch =
    matches.find((match) => match.sourceChainId === match.chain.id) ?? null;
  const minedMatch =
    matches.find((match) => match.sourceChainId !== match.chain.id) ?? null;

  return {
    originChain: knownOrigin ?? creationMatch?.chain ?? null,
    targetChain: knownTarget ?? minedMatch?.chain ?? null,
  };
}

function stage(
  input: Omit<LifecycleStage, "step"> & { step: number },
): LifecycleStage {
  return {
    ...input,
    step: `${input.step}`.padStart(2, "0"),
  };
}

function segmentCompleteness(segment: LifecycleSegment | null) {
  if (!segment) {
    return 0;
  }

  return (
    (segment.messageReceived ? 1 : 0) +
    (segment.feeExecution ? 4 : 0) +
    (segment.errorReceived ? 4 : 0) +
    segment.validationsFailed.length * 3 +
    (segment.responseReceived ? 2 : 0) +
    (segment.raiseReceived ? 2 : 0) +
    (segment.incomingResponseReceived ? 2 : 0) +
    segment.validationsStarted.length +
    segment.validationsSucceeded.length +
    segment.appLogs.length
  );
}

export async function loadRequestLifecycle(
  request: NormalizedRequest,
): Promise<RequestLifecycle> {
  const observedChains = await inferObservedChains(request);
  const originChain = observedChains.originChain;
  const targetChain = observedChains.targetChain;
  const sentLog = originChain
    ? await fetchInboxEventByRequestId(originChain, EVENT_TOPICS.messageSent, request.requestId)
    : null;
  const receivedLog = targetChain
    ? await fetchInboxEventByRequestId(
        targetChain,
        EVENT_TOPICS.messageReceived,
        request.requestId,
      )
    : null;

  let requestTxLogs =
    targetChain && receivedLog
      ? await fetchTransactionLogs(targetChain, receivedLog.transactionHash)
      : null;
  let requestSegment =
    requestTxLogs && receivedLog
      ? summarizeSegment(request.requestId, requestTxLogs, receivedLog.transactionHash)
      : null;

  if (
    targetChain &&
    receivedLog &&
    request.status === "received" &&
    requestSegment &&
    !requestSegment.feeExecution &&
    !requestSegment.errorReceived
  ) {
    const refreshedTxLogs = await fetchTransactionLogs(
      targetChain,
      receivedLog.transactionHash,
      { force: true },
    );
    const refreshedSegment = summarizeSegment(
      request.requestId,
      refreshedTxLogs,
      receivedLog.transactionHash,
    );

    if (segmentCompleteness(refreshedSegment) > segmentCompleteness(requestSegment)) {
      requestTxLogs = refreshedTxLogs;
      requestSegment = refreshedSegment;
    }
  }
  const parentRequestId = request.sourceRequestId ?? null;
  const generatedResponseLink = await findGeneratedResponseLink(
    request.requestId,
    requestSegment,
    resolveRequestById,
  );
  const responseRequestId = generatedResponseLink?.responseRequestId ?? null;
  const parentRequest = parentRequestId ? await resolveRequestById(parentRequestId) : null;
  const childRequest =
    generatedResponseLink?.responseRequest ??
    (responseRequestId ? await resolveRequestById(responseRequestId) : null);

  const outcome: RequestLifecycle["outcome"] = !receivedLog
    ? "unknown"
    : requestSegment?.errorReceived
      ? "execution_failed"
      : generatedResponseLink?.kind === "raise"
      ? "raised_error"
      : generatedResponseLink?.kind === "response"
        ? "response"
        : !request.isTwoWay
          ? "one_way_complete"
          : "unknown";

  const childRequestId = childRequest?.requestId ?? responseRequestId;
  const childReceivedTargetChain = childRequest
    ? chainById.get(childRequest.targetChainId) ?? null
    : null;
  const childReceivedLog =
    childRequestId && childReceivedTargetChain
      ? await fetchInboxEventByRequestId(
          childReceivedTargetChain,
          EVENT_TOPICS.messageReceived,
          childRequestId,
        )
      : null;
  let childTxLogs =
    childRequestId && childReceivedLog && childReceivedTargetChain
      ? await fetchTransactionLogs(childReceivedTargetChain, childReceivedLog.transactionHash)
      : null;
  let childSegment =
    childRequestId && childTxLogs && childReceivedLog
      ? summarizeSegment(childRequestId, childTxLogs, childReceivedLog.transactionHash)
      : null;

  if (
    childRequestId &&
    childReceivedLog &&
    childReceivedTargetChain &&
    childRequest?.status === "received" &&
    childSegment &&
    !childSegment.feeExecution &&
    !childSegment.errorReceived
  ) {
    const refreshedChildTxLogs = await fetchTransactionLogs(
      childReceivedTargetChain,
      childReceivedLog.transactionHash,
      { force: true },
    );
    const refreshedChildSegment = summarizeSegment(
      childRequestId,
      refreshedChildTxLogs,
      childReceivedLog.transactionHash,
    );

    if (segmentCompleteness(refreshedChildSegment) > segmentCompleteness(childSegment)) {
      childTxLogs = refreshedChildTxLogs;
      childSegment = refreshedChildSegment;
    }
  }

  const incomingResponseLog =
    childSegment?.incomingResponseReceived && childReceivedTargetChain
      ? {
          chain: childReceivedTargetChain,
          txHash: childSegment.txHash,
          sourceRequestId:
            typeof getParam(childSegment.incomingResponseReceived, "sourceRequestId") ===
            "string"
              ? String(getParam(childSegment.incomingResponseReceived, "sourceRequestId"))
              : null,
        }
      : requestSegment?.incomingResponseReceived && targetChain
        ? {
            chain: targetChain,
            txHash: requestSegment.txHash,
            sourceRequestId:
              typeof getParam(requestSegment.incomingResponseReceived, "sourceRequestId") ===
              "string"
                ? String(getParam(requestSegment.incomingResponseReceived, "sourceRequestId"))
                : null,
          }
        : null;
  const incomingResponseChain =
    incomingResponseLog?.chain ?? null;

  const errors = [
    requestSegment?.errorReceived
      ? (() => {
          const raw = String(getParam(requestSegment.errorReceived, "errorMessage") ?? "0x");
          const code = safeNumber(getParam(requestSegment.errorReceived, "errorCode") as string);
          const phase = classifyErrorPhase(
            code,
            requestSegment,
            "Validation / calldata preparation",
          );
          const decoded = decodeErrorData(raw);

          return {
            requestId: request.requestId,
            phase,
            code,
            codeLabel: decodeErrorCode(code, phase),
            description: `${decodeErrorCode(code, phase)}. ${decoded.description}`,
            raw,
            selector: decoded.selector,
            details: decoded.details,
          };
        })()
      : null,
    childSegment?.errorReceived && childRequestId
      ? (() => {
          const phase = "Return-leg execution";
          const raw = String(getParam(childSegment.errorReceived, "errorMessage") ?? "0x");
          const code = safeNumber(getParam(childSegment.errorReceived, "errorCode") as string);
          const decoded = decodeErrorData(raw);

          return {
            requestId: childRequestId,
            phase,
            code,
            codeLabel: decodeErrorCode(code, phase),
            description: `${decodeErrorCode(code, phase)}. ${decoded.description}`,
            raw,
            selector: decoded.selector,
            details: decoded.details,
          };
        })()
      : null,
  ].filter((error): error is NonNullable<typeof error> => error !== null);
  const currentRequestError =
    errors.find((entry) => entry.requestId.toLowerCase() === request.requestId.toLowerCase()) ??
    null;

  const validationLabel =
    request.methodSelector === "0x00000000"
      ? "Raw callback path; no ciphertext validation step was needed."
      : requestSegment && requestSegment.validationsFailed.length > 0
        ? `${requestSegment.validationsFailed.length} ciphertext validation failure event${
            requestSegment.validationsFailed.length === 1 ? "" : "s"
          } were emitted.`
      : requestSegment && requestSegment.validationsStarted.length > 0
        ? `${requestSegment.validationsSucceeded.length}/${requestSegment.validationsStarted.length} ciphertext checks succeeded.`
        : "No ciphertext validation events were emitted for this request, so validation was skipped.";

  const remoteGasUsed = requestSegment?.feeExecution
    ? safeNumber(getParam(requestSegment.feeExecution, "gasUsed") as string)
    : null;
  const returnGasUsed = childSegment?.feeExecution
    ? safeNumber(getParam(childSegment.feeExecution, "gasUsed") as string)
    : null;

  const stages: LifecycleStage[] = [
    stage({
      step: 1,
      key: "sent",
      title: "Message sent",
      status: sentLog ? "success" : "pending",
      chain: originChain,
      txHash: sentLog?.transactionHash ?? null,
      requestId: request.requestId,
      note: sentLog
        ? "A dApp call emitted the outbound request on the source inbox."
        : "The source-side MessageSent event could not be located from the current configuration.",
      details: [
        `Origin chain: ${originChain?.name ?? request.sourceChainId}`,
        `Target chain: ${targetChain?.name ?? request.targetChainId}`,
        `Mode: ${request.isTwoWay ? "Two-way request" : "One-way request"}`,
      ],
    }),
    stage({
      step: 2,
      key: "received",
      title: "Message received",
      status: receivedLog ? "success" : "pending",
      chain: targetChain,
      txHash: receivedLog?.transactionHash ?? null,
      requestId: request.requestId,
      note: receivedLog
        ? "The target inbox included this request inside a mined PoD block transaction."
        : "The target-side MessageReceived event is missing.",
      details: [
        receivedLog
          ? `Target inbox tx: ${truncateMiddle(receivedLog.transactionHash, 12, 10)}`
          : "Target inbox tx: pending",
        `Target contract: ${truncateMiddle(request.targetContract)}`,
      ],
    }),
    stage({
      step: 3,
      key: "validation",
      title: "Ciphertext validation",
      status:
        request.methodSelector === "0x00000000"
          ? "skipped"
          : requestSegment?.validationsFailed.length
            ? "failed"
            : requestSegment?.validationsStarted.length
            ? requestSegment.validationsSucceeded.length ===
              requestSegment.validationsStarted.length
              ? "success"
              : "pending"
            : !requestSegment || !requestSegment.messageReceived
              ? "pending"
              : "skipped"
              ,
      chain: targetChain,
      txHash: receivedLog?.transactionHash ?? null,
      requestId: request.requestId,
      note: validationLabel,
      details: [
        `Method selector: ${request.methodSelector}`,
        `Validation starts: ${requestSegment?.validationsStarted.length ?? 0}`,
        `Validation successes: ${requestSegment?.validationsSucceeded.length ?? 0}`,
        `Validation failures: ${requestSegment?.validationsFailed.length ?? 0}`,
      ],
    }),
    stage({
      step: 4,
      key: "remote-execution",
      title: "Remote method execution",
      status:
        requestSegment?.errorReceived
          ? "failed"
          : requestSegment?.feeExecution
            ? "success"
            : "pending",
      chain: targetChain,
      txHash: receivedLog?.transactionHash ?? null,
      requestId: request.requestId,
      note:
        requestSegment?.errorReceived
          ? currentRequestError?.code === 2
            ? "The inbox reported an encode failure before the remote call could be executed."
            : currentRequestError?.code === 1
              ? "The remote call failed and the inbox recorded an execution error."
              : requestSegment.feeExecution === null
                ? "Execution aborted before the subcall completed."
                : "The remote call reverted and the inbox recorded an error."
          : requestSegment?.feeExecution
            ? "The target inbox executed the request and settled execution gas."
            : "No execution settlement event was found yet.",
      details: [
        `Gas used: ${remoteGasUsed === null ? "n/a" : remoteGasUsed.toLocaleString("en-US")}`,
        `App logs captured: ${requestSegment?.appLogs.length ?? 0}`,
        requestSegment?.errorReceived
          ? `Error code: ${currentRequestError?.code ?? "n/a"} (${currentRequestError?.codeLabel ?? "Unknown"})`
          : "Error code: none",
        parentRequest
          ? `Callback selector from source request: ${parentRequest.callbackSelector}`
          : `Method selector: ${request.methodSelector}`,
      ],
    }),
  ];

  if (parentRequestId === null) {
    stages.push(
      stage({
        step: 5,
        key: "outcome",
        title: "Target-chain outcome",
        status:
          outcome === "raised_error"
            ? "failed"
            : outcome === "response" || outcome === "one_way_complete"
              ? "success"
              : outcome === "execution_failed"
                ? "failed"
                : "pending",
        chain: targetChain,
        txHash: receivedLog?.transactionHash ?? null,
        requestId: request.requestId,
        note:
          outcome === "raised_error"
            ? "The remote app raised an error payload and spawned a return-leg request."
            : outcome === "response"
              ? "The remote app responded successfully and created a return-leg request in the same transaction."
              : outcome === "one_way_complete"
                ? "This one-way request completed on the target chain with no return leg."
                : outcome === "execution_failed"
                  ? "The request failed on the target chain and no successful return leg was created."
                  : "No final outcome event has been confirmed yet.",
        details: [
          childRequestId
            ? `Related request: ${formatRequestIdCompact(childRequestId)}`
            : "No related response request was linked from this transaction.",
          generatedResponseLink
            ? `${eventName(generatedResponseLink.triggerLog)} was joined with MessageSent logs in the same transaction using sourceRequestId.`
            : "No ResponseReceived or RaiseReceived event was found for this request.",
        ],
      }),
    );

    if (childRequestId) {
      stages.push(
        stage({
          step: 6,
          key: "response-created",
          title: "Return-leg request created",
          status: generatedResponseLink?.sentLog ? "success" : "pending",
          chain: targetChain,
          txHash:
            generatedResponseLink?.sentLog?.transaction_hash ??
            requestSegment?.txHash ??
            null,
          requestId: childRequestId,
          note:
            generatedResponseLink?.kind === "raise"
              ? "The target app raised an error and created a return-leg error request."
              : "The target app created a return-leg response request.",
          details: [
            `Response request id: ${formatRequestIdCompact(childRequestId)}`,
            `Created on chain: ${targetChain?.name ?? "Unknown"}`,
          ],
        }),
      );

      stages.push(
        stage({
          step: 7,
          key: "response-received",
          title: "Return-leg message received",
          status: childReceivedLog ? "success" : "pending",
          chain: childReceivedTargetChain,
          txHash: childReceivedLog?.transactionHash ?? null,
          requestId: childRequestId,
          note: childReceivedLog
            ? "The linked response/error request was mined on its target chain."
            : "The return-leg request has not been mined yet.",
          details: [
            `Response request id: ${formatRequestIdCompact(childRequestId)}`,
            `Observed on chain: ${childReceivedTargetChain?.name ?? "Unknown"}`,
          ],
        }),
      );

      stages.push(
        stage({
          step: 8,
          key: "response-execution",
          title: "Return-leg execution",
          status:
            childSegment?.errorReceived
              ? "failed"
              : childSegment?.feeExecution
                ? "success"
                : "pending",
          chain: childReceivedTargetChain,
          txHash: childReceivedLog?.transactionHash ?? null,
          requestId: childRequestId,
          note:
            childSegment?.errorReceived
              ? "The callback/error delivery reverted on the observed response chain."
              : childSegment?.feeExecution
                ? "The response/error callback executed on the observed response chain."
                : "The return-leg execution has not settled yet.",
          details: [
            `Gas used: ${returnGasUsed === null ? "n/a" : returnGasUsed.toLocaleString("en-US")}`,
            incomingResponseLog
              ? "IncomingResponseReceived confirmed that the round trip was finalized."
              : "IncomingResponseReceived has not been observed on the response mining side yet.",
          ],
        }),
      );
    }
  } else {
    stages.push(
      stage({
        step: 5,
        key: "parent-link",
        title: "Linked parent request",
        status: "neutral",
        chain: originChain,
        txHash: null,
        requestId: parentRequestId,
        note: "This request is itself a response/error leg created for an earlier root request.",
        details: [`Parent request: ${formatRequestIdCompact(parentRequestId)}`],
      }),
    );

    stages.push(
      stage({
        step: 6,
        key: "roundtrip-finalized",
        title: "Round trip finalization",
        status:
          requestSegment?.incomingResponseReceived
            ? "success"
            : requestSegment?.feeExecution || requestSegment?.errorReceived
              ? "neutral"
              : "pending",
        chain: targetChain,
        txHash: receivedLog?.transactionHash ?? null,
        requestId: parentRequestId,
        note: requestSegment?.incomingResponseReceived
          ? "IncomingResponseReceived confirms this response was delivered back for the source request."
          : "No IncomingResponseReceived event was observed in this response mining transaction yet.",
        details: [
          `Source request: ${formatRequestIdCompact(parentRequestId)}`,
          `Current response request: ${formatRequestIdCompact(request.requestId)}`,
        ],
      }),
    );
  }

  return {
    request,
    originChain,
    targetChain,
    parentRequestId,
    parentRequest,
    sentLog: sentLog && originChain ? { chain: originChain, txHash: sentLog.transactionHash } : null,
    receivedLog:
      receivedLog && targetChain ? { chain: targetChain, txHash: receivedLog.transactionHash } : null,
    requestSegment,
    outcome,
    childRequestId,
    childRequest,
    childReceivedLog:
      childReceivedLog && childReceivedTargetChain
        ? {
            chain: childReceivedTargetChain,
            txHash: childReceivedLog.transactionHash,
          }
        : null,
    childSegment,
    incomingResponseLog: incomingResponseLog && incomingResponseChain ? incomingResponseLog : null,
    errors,
    stages,
  };
}
