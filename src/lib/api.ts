import { chainById, chainConfigs } from "../config/explorer";
import {
  hexToNumber,
  normalizeHex,
  padTopicValue,
  safeNumber,
  unpackRequestId,
} from "./format";
import type {
  AddressTransactionSummary,
  BlockSummary,
  ChainConfig,
  ChainSnapshot,
  ExplorerSnapshot,
  LegacyLog,
  NormalizedRequest,
  TransactionDetail,
  TransactionLog,
} from "../types/explorer";

type CacheEntry<T> = {
  cachedAt: number;
  promise: Promise<T>;
};

const txCache = new Map<string, CacheEntry<TransactionDetail>>();
const txLogCache = new Map<string, CacheEntry<TransactionLog[]>>();
const requestStateCache = new Map<string, CacheEntry<NormalizedRequest | null>>();

export const EVENT_TOPICS = {
  messageSent:
    "0x1f7915a5c7a426fe4b782487cd1c9f493c24108132d2bc123062cbb22a9d8063",
  messageReceived:
    "0x8640cc4eb5cb8fe1cef18587479d948bda9aadb5430414cc590c148389107161",
  responseReceived:
    "0x2e58a9a9da8f950879e524a06e33834a54fee2efe5378327cfbafde627023a76",
  raiseReceived:
    "0x4f1c56425c1d76315d766fe8a683810da5c4724053f79a5f5d0bb11442df3418",
  incomingResponseReceived:
    "0x118867117cb9a056a7c657d6ed6909420b7731483aefdf3d93eabf192d42c889",
  errorReceived:
    "0x29ff7f1fd2f2d9fb80e799277cfd717bb1e8517f7b97cb5dec3a2986450cfc12",
  feeExecutionSettled:
    "0xd07b914766ee18e6b7d815e14c64d41af98562862324bdf1d2427a15928791f8",
  validateCiphertextStart:
    "0xe87280f881e13be09165a6d19de01358993fdadcbba1f7ce7fd7db8de23a233d",
  validateCiphertextSuccess:
    "0x9bbb0b110439a6673356ba43f12e4a33d486e53db05beb8ad4aaa3e45a3cd694",
} as const;

const REQUESTS_GETTER_SELECTOR = "0x9d866985";

function buildLegacyLogsUrl(chain: ChainConfig) {
  const params = new URLSearchParams();
  params.set("module", "logs");
  params.set("action", "getLogs");
  params.set("fromBlock", "0");
  params.set("toBlock", "latest");
  params.set("address", chain.inboxAddress);
  params.set("topic0", chain.messageReceivedTopic);

  return `${chain.apiBaseUrl}/api?${params.toString()}`;
}

function buildFilteredLegacyLogsUrl(
  chain: ChainConfig,
  {
    topic0,
    topic1,
    topic2,
  }: {
    topic0: string;
    topic1?: string;
    topic2?: string;
  },
) {
  const params = new URLSearchParams({
    module: "logs",
    action: "getLogs",
    fromBlock: "0",
    toBlock: "latest",
    address: chain.inboxAddress,
    topic0,
  });

  if (topic1) {
    params.set("topic1", topic1);
    params.set("topic0_1_opr", "and");
  }

  if (topic2) {
    params.set("topic2", topic2);
    if (topic1) {
      params.set("topic1_2_opr", "and");
    } else {
      params.set("topic0_2_opr", "and");
    }
  }

  return `${chain.apiBaseUrl}/api?${params.toString()}`;
}

function buildTxUrl(chain: ChainConfig, txHash: string) {
  return `${chain.apiBaseUrl}/api/v2/transactions/${txHash}`;
}

function buildTxLogsUrl(chain: ChainConfig, txHash: string) {
  return `${chain.apiBaseUrl}/api/v2/transactions/${txHash}/logs`;
}

function buildAddressTxListUrl(chain: ChainConfig, address: string) {
  const params = new URLSearchParams({
    module: "account",
    action: "txlist",
    address,
    startblock: "0",
    endblock: "99999999",
    sort: "desc",
  });

  return `${chain.apiBaseUrl}/api?${params.toString()}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchRpcJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function getCachedPromise<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
) {
  const now = Date.now();
  const existing = cache.get(key);

  if (existing && now - existing.cachedAt < ttlMs) {
    return existing.promise;
  }

  const promise = load().catch((error) => {
    const current = cache.get(key);
    if (current?.promise === promise) {
      cache.delete(key);
    }

    throw error;
  });

  cache.set(key, {
    cachedAt: now,
    promise,
  });

  return promise;
}

export async function fetchMessageReceivedLogs(chain: ChainConfig) {
  const payload = await fetchJson<{ message: string; result: LegacyLog[] }>(
    buildLegacyLogsUrl(chain),
  );

  return payload.result;
}

export async function fetchMessageSentLogs(chain: ChainConfig) {
  const payload = await fetchJson<{ message: string; result: LegacyLog[] }>(
    buildFilteredLegacyLogsUrl(chain, {
      topic0: EVENT_TOPICS.messageSent,
    }),
  );

  return payload.result;
}

export async function fetchLegacyLogsByTopics(
  chain: ChainConfig,
  {
    topic0,
    topic1,
    topic2,
  }: {
    topic0: string;
    topic1?: string;
    topic2?: string;
  },
) {
  const payload = await fetchJson<{ message: string; result: LegacyLog[] | null }>(
    buildFilteredLegacyLogsUrl(chain, {
      topic0,
      topic1,
      topic2,
    }),
  );

  return payload.result ?? [];
}

export async function fetchInboxEventByRequestId(
  chain: ChainConfig,
  topic0: string,
  requestId: string,
) {
  const logs = await fetchLegacyLogsByTopics(chain, {
    topic0,
    topic1: padTopicValue(requestId),
  });

  return logs[0] ?? null;
}

export async function fetchTransaction(chain: ChainConfig, txHash: string) {
  const cacheKey = `${chain.slug}:${normalizeHex(txHash)}`;
  return getCachedPromise(txCache, cacheKey, 5_000, () =>
    fetchJson<TransactionDetail>(buildTxUrl(chain, txHash)),
  );
}

export async function fetchTransactionLogs(
  chain: ChainConfig,
  txHash: string,
  options?: { force?: boolean },
) {
  const cacheKey = `${chain.slug}:${normalizeHex(txHash)}`;
  if (options?.force) {
    txLogCache.delete(cacheKey);
  }

  return getCachedPromise(txLogCache, cacheKey, 2_000, () =>
    fetchJson<{ items: TransactionLog[] }>(buildTxLogsUrl(chain, txHash)).then(
      (payload) => payload.items,
    ),
  );
}

function getDecodedParameter(tx: TransactionDetail, name: string) {
  return tx.decoded_input?.parameters.find((parameter) => parameter.name === name)?.value;
}

function getAbiWord(data: string, index: number) {
  const normalized = data.replace(/^0x/, "");
  return normalized.slice(index * 64, (index + 1) * 64);
}

function getAbiOffset(data: string, index: number) {
  return Number(BigInt(`0x${getAbiWord(data, index)}`));
}

function getAbiBool(data: string, index: number) {
  return BigInt(`0x${getAbiWord(data, index)}`) !== 0n;
}

function getAbiUint(data: string, index: number) {
  return BigInt(`0x${getAbiWord(data, index)}`);
}

function getAbiBytes32(data: string, index: number) {
  return `0x${getAbiWord(data, index)}`;
}

function getAbiAddress(data: string, index: number) {
  return `0x${getAbiWord(data, index).slice(24)}`;
}

function getDynamicBytes(data: string, baseOffsetBytes: number) {
  const start = baseOffsetBytes * 2;
  const length = Number(BigInt(`0x${data.slice(start, start + 64)}`));
  return `0x${data.slice(start + 64, start + 64 + length * 2)}`;
}

function getDynamicBytes8Array(data: string, baseOffsetBytes: number) {
  const start = baseOffsetBytes * 2;
  const length = Number(BigInt(`0x${data.slice(start, start + 64)}`));
  const values: string[] = [];

  for (let index = 0; index < length; index += 1) {
    const word = data.slice(start + 64 + index * 64, start + 64 + (index + 1) * 64);
    values.push(`0x${word.slice(0, 16)}`);
  }

  return values;
}

function getDynamicBytes32Array(data: string, baseOffsetBytes: number) {
  const start = baseOffsetBytes * 2;
  const length = Number(BigInt(`0x${data.slice(start, start + 64)}`));
  const values: string[] = [];

  for (let index = 0; index < length; index += 1) {
    const word = data.slice(start + 64 + index * 64, start + 64 + (index + 1) * 64);
    values.push(`0x${word}`);
  }

  return values;
}

function parseTopicUint(topic: string | undefined | null) {
  if (!topic) {
    return 0;
  }

  try {
    return Number(BigInt(topic));
  } catch {
    return 0;
  }
}

function compareLegacyLogs(left: LegacyLog, right: LegacyLog) {
  const blockDelta = hexToNumber(left.blockNumber) - hexToNumber(right.blockNumber);
  if (blockDelta !== 0) {
    return blockDelta;
  }

  return hexToNumber(left.logIndex) - hexToNumber(right.logIndex);
}

type ChainLogMatch = {
  chain: ChainConfig;
  log: LegacyLog;
  sourceChainId: number;
};

function isKnownChainId(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && chainById.has(value);
}

function pickKnownChainId(...values: Array<number | null | undefined>) {
  for (const value of values) {
    if (isKnownChainId(value)) {
      return value;
    }
  }

  return null;
}

async function fetchStoredRequest(
  chain: ChainConfig,
  requestId: string,
): Promise<NormalizedRequest | null> {
  const cacheKey = `${chain.slug}:${normalizeHex(requestId)}`;
  return getCachedPromise(requestStateCache, cacheKey, 5_000, async () => {
        const payload = await fetchRpcJson<{
          result?: string;
          error?: { message?: string };
        }>(chain.rpcUrl, {
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [
            {
              to: chain.inboxAddress,
              data: `${REQUESTS_GETTER_SELECTOR}${padTopicValue(requestId).slice(2)}`,
            },
            "latest",
          ],
        });

        if (!payload.result || payload.result === "0x") {
          return null;
        }

        const data = payload.result.replace(/^0x/, "");
        const storedRequestId = getAbiBytes32(data, 0);
        if (normalizeHex(storedRequestId) === normalizeHex(`0x${"0".repeat(64)}`)) {
          return null;
        }

        const targetChainId = Number(getAbiUint(data, 1));
        const methodCallOffset = getAbiOffset(data, 3);
        const methodCallBase = methodCallOffset;
        const methodCallSelector = `0x${data.slice(methodCallBase * 2, methodCallBase * 2 + 8)}`;
        const methodDataOffset = Number(
          BigInt(`0x${data.slice(methodCallBase * 2 + 64, methodCallBase * 2 + 128)}`),
        );
        const datatypesOffset = Number(
          BigInt(`0x${data.slice(methodCallBase * 2 + 128, methodCallBase * 2 + 192)}`),
        );
        const datalensOffset = Number(
          BigInt(`0x${data.slice(methodCallBase * 2 + 192, methodCallBase * 2 + 256)}`),
        );
        const methodDataPreview = getDynamicBytes(data, methodCallBase + methodDataOffset);
        const sourceChainId = chain.id;
        const targetChain = chainById.get(targetChainId);
        const { nonce } = unpackRequestId(storedRequestId);

        return {
          requestId: storedRequestId,
          txHash: "",
          creationTxHash: null,
          minedTxHash: null,
          status: "created",
          chainSlug: targetChain?.slug ?? chain.slug,
          sourceChainId,
          targetChainId,
          sourceContract: getAbiAddress(data, 4),
          targetContract: getAbiAddress(data, 2),
          originalSender: getAbiAddress(data, 5),
          sourceRequestId:
            normalizeHex(getAbiBytes32(data, 11)) === normalizeHex(`0x${"0".repeat(64)}`)
              ? null
              : getAbiBytes32(data, 11),
          callbackSelector: `0x${getAbiWord(data, 7).slice(0, 8)}`,
          errorSelector: `0x${getAbiWord(data, 8).slice(0, 8)}`,
          methodSelector: methodCallSelector,
          methodDataPreview,
          gasRemote: Number(getAbiUint(data, 12)),
          gasLocal: Number(getAbiUint(data, 13)),
          isTwoWay: getAbiBool(data, 9),
          blockNumber: 0,
          timestamp: new Date(Number(getAbiUint(data, 6)) * 1000).toISOString(),
          logIndex: 0,
          requestNonce: nonce,
        };
      });
}

function getLogParameter(log: TransactionLog, name: string) {
  return log.decoded?.parameters.find((parameter) => parameter.name === name)?.value;
}

function findTransactionLog(txLogs: TransactionLog[], logIndex: number, eventPrefix: string) {
  return txLogs.find(
    (log) =>
      log.index === logIndex &&
      (log.decoded?.method_call.startsWith(eventPrefix) ?? false),
  );
}

function resolveSourceContractForSentLog(
  chain: ChainConfig,
  tx: TransactionDetail,
  txLogs: TransactionLog[],
  currentLogIndex: number,
) {
  if (tx.to?.hash && normalizeHex(tx.to.hash) !== normalizeHex(chain.inboxAddress)) {
    return tx.to.hash;
  }

  for (let index = currentLogIndex - 1; index >= 0; index -= 1) {
    const candidate = txLogs[index];
    if (
      candidate &&
      normalizeHex(candidate.address.hash) !== normalizeHex(chain.inboxAddress)
    ) {
      return candidate.address.hash;
    }
  }

  return tx.from.hash;
}

function parseMinedRequest(
  chain: ChainConfig,
  tx: TransactionDetail,
  sourceChainId: number,
  entry: unknown,
  matchedLogIndex?: number,
): NormalizedRequest | null {
  if (!Array.isArray(entry)) {
    return null;
  }

  const methodCall = Array.isArray(entry[3]) ? entry[3] : [];
  const requestId = String(entry[0]);
  const sourceRequestId =
    String(entry[7]) ===
    "0x0000000000000000000000000000000000000000000000000000000000000000"
      ? null
      : String(entry[7]);

  const { nonce } = unpackRequestId(requestId);

  return {
    requestId,
    txHash: tx.hash,
    creationTxHash: null,
    minedTxHash: tx.hash,
    status: "received",
    chainSlug: chain.slug,
    sourceChainId,
    targetChainId: chain.id,
    sourceContract: String(entry[1]),
    targetContract: String(entry[2]),
    originalSender: "",
    sourceRequestId,
    callbackSelector: String(entry[4]),
    errorSelector: String(entry[5]),
    methodSelector: String(methodCall[0] ?? "0x00000000"),
    methodDataPreview: String(methodCall[1] ?? "0x"),
    gasRemote: safeNumber(entry[8] as string),
    gasLocal: safeNumber(entry[9] as string),
    isTwoWay: entry[6] === true || entry[6] === "true",
    blockNumber: tx.block_number,
    timestamp: tx.timestamp,
    logIndex: matchedLogIndex ?? 0,
    requestNonce: nonce,
  };
}

async function buildRequestFromSentLog(
  chain: ChainConfig,
  log: LegacyLog,
): Promise<NormalizedRequest | null> {
  const tx = await fetchTransaction(chain, log.transactionHash);
  const txLogs = await fetchTransactionLogs(chain, log.transactionHash);
  const decodedLog = findTransactionLog(
    txLogs,
    hexToNumber(log.logIndex),
    "MessageSent",
  );

  if (!decodedLog) {
    return null;
  }

  const requestId = String(getLogParameter(decodedLog, "requestId") ?? normalizeHex(log.topics[1]));
  const targetChainId = safeNumber(getLogParameter(decodedLog, "targetChainId") as string);
  const targetChain = chainById.get(targetChainId);
  const methodCall = Array.isArray(getLogParameter(decodedLog, "methodCall"))
    ? (getLogParameter(decodedLog, "methodCall") as unknown[])
    : [];
  const callbackSelector = String(
    getLogParameter(decodedLog, "callbackSelector") ?? "0x00000000",
  );
  const errorSelector = String(
    getLogParameter(decodedLog, "errorSelector") ?? "0x00000000",
  );
  const sourceContract = resolveSourceContractForSentLog(
    chain,
    tx,
    txLogs,
    decodedLog.index,
  );
  const { nonce } = unpackRequestId(requestId);

  return {
    requestId,
    txHash: tx.hash,
    creationTxHash: tx.hash,
    minedTxHash: null,
    status: "created",
    chainSlug: targetChain?.slug ?? chain.slug,
    sourceChainId: chain.id,
    targetChainId,
    sourceContract,
    targetContract: String(getLogParameter(decodedLog, "targetContract") ?? tx.to?.hash ?? ""),
    originalSender: tx.from.hash,
    sourceRequestId: null,
    callbackSelector,
    errorSelector,
    methodSelector: String(methodCall[0] ?? "0x00000000"),
    methodDataPreview: String(methodCall[1] ?? "0x"),
    gasRemote: null,
    gasLocal: null,
    isTwoWay: normalizeHex(callbackSelector) !== "0x00000000",
    blockNumber: tx.block_number,
    timestamp: tx.timestamp,
    logIndex: decodedLog.index,
    requestNonce: nonce,
  };
}

function mergeRequests(
  sentRequest: NormalizedRequest | null,
  minedRequest: NormalizedRequest | null,
) {
  if (sentRequest && minedRequest) {
    return {
      ...minedRequest,
      txHash: minedRequest.txHash,
      creationTxHash: sentRequest.creationTxHash ?? minedRequest.creationTxHash,
      minedTxHash: minedRequest.minedTxHash ?? minedRequest.txHash,
      status: "received" as const,
      sourceContract: minedRequest.sourceContract || sentRequest.sourceContract,
      originalSender: sentRequest.originalSender || minedRequest.originalSender,
      callbackSelector: sentRequest.callbackSelector || minedRequest.callbackSelector,
      errorSelector: sentRequest.errorSelector || minedRequest.errorSelector,
      methodSelector: sentRequest.methodSelector || minedRequest.methodSelector,
      methodDataPreview: sentRequest.methodDataPreview || minedRequest.methodDataPreview,
      gasRemote: minedRequest.gasRemote ?? sentRequest.gasRemote,
      gasLocal: minedRequest.gasLocal ?? sentRequest.gasLocal,
      isTwoWay: minedRequest.isTwoWay,
      timestamp: minedRequest.timestamp,
      blockNumber: minedRequest.blockNumber,
      logIndex: minedRequest.logIndex,
    } satisfies NormalizedRequest;
  }

  return sentRequest ?? minedRequest;
}

function requestCompletenessScore(request: NormalizedRequest) {
  return (
    (request.status === "received" ? 100 : 0) +
    (request.minedTxHash ? 40 : 0) +
    (request.creationTxHash ? 10 : 0) +
    (request.txHash ? 5 : 0) +
    (request.gasRemote !== null ? 4 : 0) +
    (request.gasLocal !== null ? 4 : 0) +
    (request.sourceContract ? 3 : 0) +
    (request.targetContract ? 3 : 0) +
    (request.sourceRequestId ? 2 : 0) +
    (request.methodSelector !== "0x00000000" ? 2 : 0) +
    (request.callbackSelector !== "0x00000000" ? 1 : 0) +
    (request.errorSelector !== "0x00000000" ? 1 : 0)
  );
}

function preferMoreCompleteRequest(
  current: NormalizedRequest | null,
  candidate: NormalizedRequest,
) {
  if (!current) {
    return candidate;
  }

  const currentScore = requestCompletenessScore(current);
  const candidateScore = requestCompletenessScore(candidate);

  if (candidateScore > currentScore) {
    return candidate;
  }

  if (candidateScore < currentScore) {
    return current;
  }

  const currentTime = new Date(current.timestamp).getTime();
  const candidateTime = new Date(candidate.timestamp).getTime();

  if (candidateTime > currentTime) {
    return candidate;
  }

  if (candidateTime < currentTime) {
    return current;
  }

  return current;
}

async function findReceivedMatchesByRequestId(requestId: string) {
  const paddedRequestId = padTopicValue(requestId);
  const matches = (
    await Promise.all(
      chainConfigs.map(async (chain) => {
        try {
          const logs = await fetchLegacyLogsByTopics(chain, {
            topic0: EVENT_TOPICS.messageReceived,
            topic1: paddedRequestId,
          });

          return logs.map((log) => ({
            chain,
            log,
            sourceChainId: parseTopicUint(log.topics[2]),
          }));
        } catch {
          return [] as ChainLogMatch[];
        }
      }),
    )
  )
    .flat()
    .sort((left, right) => compareLegacyLogs(left.log, right.log));

  return {
    creation:
      matches.find((match) => match.sourceChainId === match.chain.id) ?? null,
    mined:
      matches.find((match) => match.sourceChainId !== match.chain.id) ?? null,
  };
}

async function findSentRequestById(sourceChain: ChainConfig | null, requestId: string) {
  const paddedRequestId = padTopicValue(requestId);
  const chainsToSearch = sourceChain ? [sourceChain] : chainConfigs;

  for (const chain of chainsToSearch) {
    try {
      const sentLogs = await fetchLegacyLogsByTopics(chain, {
        topic0: EVENT_TOPICS.messageSent,
        topic1: paddedRequestId,
      });

      if (sentLogs[0]) {
        const sentRequest = await buildRequestFromSentLog(chain, sentLogs[0]);
        if (sentRequest) {
          return sentRequest;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function getRequestLogIndexMapFromLegacyLogs(logs: LegacyLog[]) {
  return new Map(
    logs.map((log) => [normalizeHex(log.topics[1]), hexToNumber(log.logIndex)]),
  );
}

function getRequestLogIndexMapFromTransactionLogs(txLogs: TransactionLog[]) {
  const map = new Map<string, number>();

  for (const log of txLogs) {
    if (!log.decoded?.method_call.startsWith("MessageReceived")) {
      continue;
    }

    const requestId = log.decoded.parameters.find(
      (parameter) => parameter.name === "requestId",
    )?.value;
    if (typeof requestId === "string") {
      map.set(normalizeHex(requestId), log.index);
    }
  }

  return map;
}

export function buildBlockFromTransaction(
  chain: ChainConfig,
  tx: TransactionDetail,
  requestLogIndexMap: Map<string, number>,
): BlockSummary | null {
  const sourceChainId = safeNumber(getDecodedParameter(tx, "sourceChainId") as string);
  const mined = getDecodedParameter(tx, "mined");
  if (!Array.isArray(mined)) {
    return null;
  }

  const requests = mined
    .map((entry) =>
      parseMinedRequest(
        chain,
        tx,
        sourceChainId,
        entry,
        requestLogIndexMap.get(normalizeHex(String(Array.isArray(entry) ? entry[0] : ""))),
      ),
    )
    .filter((request): request is NormalizedRequest => request !== null)
    .sort((left, right) => left.logIndex - right.logIndex);

  return {
    txHash: tx.hash,
    chainSlug: chain.slug,
    sourceChainId,
    targetChainId: chain.id,
    blockNumber: tx.block_number,
    requestCount: requests.length,
    timestamp: tx.timestamp,
    gasUsed: safeNumber(tx.gas_used),
    gasPrice: tx.gas_price,
    feeValue: tx.fee?.value ?? "0",
    status: tx.status,
    method: tx.method,
    from: tx.from.hash,
    to: tx.to?.hash ?? chain.inboxAddress,
    requests,
  };
}

export async function loadChainSnapshot(chain: ChainConfig): Promise<ChainSnapshot> {
  const [allReceivedLogs, allSentLogs] = await Promise.all([
    fetchMessageReceivedLogs(chain),
    fetchMessageSentLogs(chain),
  ]);
  const orderedLogs = [...allReceivedLogs].sort((left, right) => {
    const blockDelta = hexToNumber(left.blockNumber) - hexToNumber(right.blockNumber);
    if (blockDelta !== 0) {
      return blockDelta;
    }

    return hexToNumber(left.logIndex) - hexToNumber(right.logIndex);
  });
  const orderedSentLogs = [...allSentLogs].sort((left, right) => {
    const blockDelta = hexToNumber(left.blockNumber) - hexToNumber(right.blockNumber);
    if (blockDelta !== 0) {
      return blockDelta;
    }

    return hexToNumber(left.logIndex) - hexToNumber(right.logIndex);
  });

  const recentAnchorLogs = orderedLogs.slice(-chain.lookbackLogs);
  const recentSentLogs = orderedSentLogs.slice(-chain.lookbackLogs);
  const selectedTxHashes = new Set(
    recentAnchorLogs.map((log) => normalizeHex(log.transactionHash)),
  );
  const selectedLogs = orderedLogs.filter((log) =>
    selectedTxHashes.has(normalizeHex(log.transactionHash)),
  );

  const logsByTx = new Map<string, LegacyLog[]>();
  for (const log of selectedLogs) {
    const key = normalizeHex(log.transactionHash);
    const group = logsByTx.get(key) ?? [];
    group.push(log);
    logsByTx.set(key, group);
  }

  const sentRequests = (
    await Promise.all(recentSentLogs.map((log) => buildRequestFromSentLog(chain, log)))
  )
    .filter((request): request is NormalizedRequest => request !== null)
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
    );

  const blocks = (
    await Promise.all(
      [...logsByTx.entries()].map(async ([txHash, logs]) => {
        const tx = await fetchTransaction(chain, txHash);
        return buildBlockFromTransaction(
          chain,
          tx,
          getRequestLogIndexMapFromLegacyLogs(logs),
        );
      }),
    )
  )
    .filter((block): block is BlockSummary => block !== null)
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
    );

  const minedRequests = blocks.flatMap((block) => block.requests);
  const requestIds = new Set<string>();
  const requests = [...sentRequests, ...minedRequests]
    .map((request) => {
      const key = normalizeHex(request.requestId);
      if (requestIds.has(key)) {
        return null;
      }

      requestIds.add(key);
      const sentMatch =
        sentRequests.find((candidate) => normalizeHex(candidate.requestId) === key) ?? null;
      const minedMatch =
        minedRequests.find((candidate) => normalizeHex(candidate.requestId) === key) ?? null;
      return mergeRequests(sentMatch, minedMatch);
    })
    .filter((request): request is NormalizedRequest => request !== null)
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
    );

  return {
    chain,
    blocks,
    requests,
  };
}

export async function loadExplorerSnapshot(): Promise<ExplorerSnapshot> {
  const chains = await Promise.all(chainConfigs.map((chain) => loadChainSnapshot(chain)));
  const blocks = chains
    .flatMap((chain) => chain.blocks)
    .sort(
      (left, right) =>
        new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
    );
  const requestMap = new Map<string, NormalizedRequest>();
  for (const request of chains.flatMap((chain) => chain.requests)) {
    const key = normalizeHex(request.requestId);
    requestMap.set(
      key,
      preferMoreCompleteRequest(requestMap.get(key) ?? null, request),
    );
  }

  const requests = [...requestMap.values()].sort(
    (left, right) =>
      new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
  );

  return {
    chains,
    blocks,
    requests,
    generatedAt: new Date().toISOString(),
  };
}

export async function resolveBlockTransaction(txHash: string) {
  for (const chain of chainConfigs) {
    try {
      const tx = await fetchTransaction(chain, txHash);
      if (tx.method !== "batchProcessRequests") {
        continue;
      }

      return { chain, tx };
    } catch {
      continue;
    }
  }

  return null;
}

export async function resolveBlockFromHash(chain: ChainConfig, txHash: string) {
  const tx = await fetchTransaction(chain, txHash);
  const txLogs = await fetchTransactionLogs(chain, txHash);
  return buildBlockFromTransaction(
    chain,
    tx,
    getRequestLogIndexMapFromTransactionLogs(txLogs),
  );
}

export async function resolveRequestById(requestId: string) {
  const normalizedRequestId = normalizeHex(requestId);
  const receivedMatches = await findReceivedMatchesByRequestId(requestId);
  const unpackedRequestId = unpackRequestId(requestId);
  const sourceChainId =
    pickKnownChainId(
      receivedMatches.creation?.sourceChainId,
      receivedMatches.mined?.sourceChainId,
      unpackedRequestId.chainId,
    ) ?? unpackedRequestId.chainId;
  const sourceChain = chainById.get(sourceChainId) ?? null;

  const [storedRequest, sentRequest] = await Promise.all([
    sourceChain ? fetchStoredRequest(sourceChain, requestId) : Promise.resolve(null),
    findSentRequestById(sourceChain, requestId),
  ]);

  let minedRequest: NormalizedRequest | null = null;
  if (receivedMatches.mined) {
    try {
      const block = await resolveBlockFromHash(
        receivedMatches.mined.chain,
        receivedMatches.mined.log.transactionHash,
      );
      minedRequest =
        block?.requests.find(
          (candidate) => normalizeHex(candidate.requestId) === normalizedRequestId,
        ) ?? null;
    } catch {
      minedRequest = null;
    }
  }

  const { nonce } = unpackedRequestId;
  const creationLog = receivedMatches.creation?.log ?? null;
  const minedLog = receivedMatches.mined?.log ?? null;
  const targetChainId =
    pickKnownChainId(
      storedRequest?.targetChainId,
      minedRequest?.targetChainId,
      receivedMatches.mined?.chain.id,
      sentRequest?.targetChainId,
    ) ?? sourceChainId;
  const sourceContract =
    storedRequest?.sourceContract ??
    sentRequest?.sourceContract ??
    minedRequest?.sourceContract ??
    "";
  const targetContract =
    storedRequest?.targetContract ??
    sentRequest?.targetContract ??
    minedRequest?.targetContract ??
    "";
  const methodSelector =
    storedRequest?.methodSelector ??
    sentRequest?.methodSelector ??
    minedRequest?.methodSelector ??
    "0x00000000";
  const methodDataPreview =
    storedRequest?.methodDataPreview ??
    sentRequest?.methodDataPreview ??
    minedRequest?.methodDataPreview ??
    "0x";
  const callbackSelector =
    storedRequest?.callbackSelector ??
    sentRequest?.callbackSelector ??
    minedRequest?.callbackSelector ??
    "0x00000000";
  const errorSelector =
    storedRequest?.errorSelector ??
    sentRequest?.errorSelector ??
    minedRequest?.errorSelector ??
    "0x00000000";
  const sourceRequestId =
    storedRequest?.sourceRequestId ??
    minedRequest?.sourceRequestId ??
    sentRequest?.sourceRequestId ??
    null;
  const originalSender =
    storedRequest?.originalSender ??
    sentRequest?.originalSender ??
    minedRequest?.originalSender ??
    "";
  const timestamp =
    creationLog
      ? new Date(Number.parseInt(creationLog.timeStamp, 10) * 1000).toISOString()
      : sentRequest?.timestamp ??
        storedRequest?.timestamp ??
        minedRequest?.timestamp ??
        new Date(0).toISOString();
  const blockNumber = creationLog
    ? hexToNumber(creationLog.blockNumber)
    : sentRequest?.blockNumber ??
      storedRequest?.blockNumber ??
      minedRequest?.blockNumber ??
      0;
  const logIndex = creationLog
    ? hexToNumber(creationLog.logIndex)
    : sentRequest?.logIndex ??
      storedRequest?.logIndex ??
      minedRequest?.logIndex ??
      0;

  if (storedRequest || sentRequest || minedRequest || creationLog || minedLog) {
    return {
      requestId,
      txHash: creationLog?.transactionHash ?? sentRequest?.txHash ?? "",
      creationTxHash:
        creationLog?.transactionHash ??
        sentRequest?.creationTxHash ??
        sentRequest?.txHash ??
        null,
      minedTxHash: minedLog?.transactionHash ?? minedRequest?.minedTxHash ?? null,
      status: minedLog ? "received" : "created",
      chainSlug: sourceChain?.slug ?? storedRequest?.chainSlug ?? sentRequest?.chainSlug ?? "sepolia",
      sourceChainId,
      targetChainId,
      sourceContract,
      targetContract,
      originalSender,
      sourceRequestId,
      callbackSelector,
      errorSelector,
      methodSelector,
      methodDataPreview,
      gasRemote:
        storedRequest?.gasRemote ??
        minedRequest?.gasRemote ??
        sentRequest?.gasRemote ??
        null,
      gasLocal:
        storedRequest?.gasLocal ??
        minedRequest?.gasLocal ??
        sentRequest?.gasLocal ??
        null,
      isTwoWay:
        storedRequest?.isTwoWay ??
        minedRequest?.isTwoWay ??
        sentRequest?.isTwoWay ??
        false,
      blockNumber,
      timestamp,
      logIndex,
      requestNonce: nonce,
    } satisfies NormalizedRequest;
  }

  return null;
}

export async function resolveRequestFromTransaction(txHash: string) {
  for (const chain of chainConfigs) {
    try {
      const txLogs = await fetchTransactionLogs(chain, txHash);
      const sentLogs = txLogs.filter((log) =>
        log.decoded?.method_call.startsWith("MessageSent"),
      );

      if (sentLogs.length) {
        const requestId = getLogParameter(sentLogs[0], "requestId");
        if (typeof requestId === "string") {
          return resolveRequestById(requestId);
        }
      }

      const createdReceivedLogs = txLogs.filter((log) => {
        if (!log.decoded?.method_call.startsWith("MessageReceived")) {
          return false;
        }

        const sourceChainId = safeNumber(getLogParameter(log, "sourceChainId") as string);
        return sourceChainId === chain.id;
      });

      if (createdReceivedLogs.length) {
        const requestId = getLogParameter(createdReceivedLogs[0], "requestId");
        if (typeof requestId === "string") {
          return resolveRequestById(requestId);
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function fetchAddressTransactions(
  chain: ChainConfig,
  address: string,
) {
  const payload = await fetchJson<{
    message?: string;
    result?: Array<{
      blockNumber: string;
      timeStamp: string;
      hash: string;
      from: string;
      to: string;
      value: string;
      txreceipt_status?: string;
      isError?: string;
      functionName?: string;
      methodId?: string;
    }> | null;
  }>(buildAddressTxListUrl(chain, address));

  return (payload.result ?? []).map((item) => ({
    chainSlug: chain.slug,
    hash: item.hash,
    timestamp: new Date(Number.parseInt(item.timeStamp, 10) * 1000).toISOString(),
    blockNumber: Number.parseInt(item.blockNumber, 10),
    status:
      item.txreceipt_status === "1" || item.isError === "0" ? "ok" : "failed",
    method: item.functionName || item.methodId || "Transaction",
    from: item.from,
    to: item.to || null,
    value: item.value,
  })) satisfies AddressTransactionSummary[];
}
