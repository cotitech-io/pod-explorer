import { FormEvent, useEffect, useState } from "react";
import { ChainLogo } from "./components/chain-logo";
import { chainById, chainBySlug, chainConfigs, explorerConfig } from "./config/explorer";
import {
  fetchAddressTransactions,
  fetchTransactionLogs,
  loadExplorerSnapshot,
  resolveBlockFromHash,
  resolveBlockTransaction,
  resolveRequestFromTransaction,
  resolveRequestById,
} from "./lib/api";
import {
  loadRequestLifecycle,
  type RequestLifecycle,
  type StageStatus,
} from "./lib/request-lifecycle";
import {
  cn,
  copyToClipboard,
  formatDateTime,
  formatNumber,
  formatRequestIdCompact,
  formatRelative,
  normalizeHex,
  packChainLabel,
  truncateMiddle,
  unpackRequestId,
} from "./lib/format";
import type {
  AddressTransactionSummary,
  BlockSummary,
  ChainConfig,
  ChainSlug,
  ExplorerSnapshot,
  NormalizedRequest,
  TransactionLog,
} from "./types/explorer";

type Route =
  | { name: "home" }
  | { name: "block"; chainSlug: ChainSlug; txHash: string }
  | { name: "request"; chainSlug: ChainSlug; requestId: string }
  | { name: "account"; address: string };

function parseHashRoute(hash: string): Route {
  const normalized = hash.replace(/^#/, "") || "/";
  const parts = normalized.split("/").filter(Boolean);

  if (parts[0] === "block" && parts[1] && parts[2]) {
    return {
      name: "block",
      chainSlug: parts[1] as ChainSlug,
      txHash: parts[2],
    };
  }

  if (parts[0] === "request" && parts[1] && parts[2]) {
    return {
      name: "request",
      chainSlug: parts[1] as ChainSlug,
      requestId: parts[2],
    };
  }

  if (parts[0] === "account" && parts[1]) {
    return {
      name: "account",
      address: parts[1],
    };
  }

  return { name: "home" };
}

function navigateTo(path: string) {
  window.location.hash = path;
}

function isAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function useHashRoute() {
  const [route, setRoute] = useState<Route>(() => parseHashRoute(window.location.hash));

  useEffect(() => {
    const handle = () => setRoute(parseHashRoute(window.location.hash));
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);

  return route;
}

function useExplorerSnapshotState() {
  const [snapshot, setSnapshot] = useState<ExplorerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function reload(options?: { background?: boolean }) {
    const isBackground = options?.background === true;
    if (!isBackground) {
      setLoading(true);
    }
    setError(null);

    try {
      const nextSnapshot = await loadExplorerSnapshot();
      setSnapshot(nextSnapshot);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Could not load PoD explorer data.",
      );
    } finally {
      if (!isBackground) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void reload();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;

    const intervalId = window.setInterval(() => {
      if (cancelled || inFlight || document.hidden) {
        return;
      }

      inFlight = true;
      void reload({ background: true }).finally(() => {
        inFlight = false;
      });
    }, explorerConfig.autoRefreshMs);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  return { snapshot, loading, error, reload };
}

function useResolvedBlock(
  route: Route,
  existingBlock: BlockSummary | null,
  snapshotLoading: boolean,
) {
  const [block, setBlock] = useState<BlockSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const routeBlockKey =
    route.name === "block" ? `${route.chainSlug}:${normalizeHex(route.txHash)}` : null;
  const existingBlockKey = existingBlock
    ? `${existingBlock.chainSlug}:${normalizeHex(existingBlock.txHash)}`
    : null;

  useEffect(() => {
    if (route.name !== "block") {
      setBlock(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (existingBlock || snapshotLoading) {
      setBlock(existingBlock);
      setLoading(false);
      setError(null);
      return;
    }

    const chain = chainBySlug.get(route.chainSlug);
    if (!chain) {
      setBlock(null);
      setError("Unknown chain configuration.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const resolved = await resolveBlockFromHash(chain, route.txHash);
        if (!cancelled) {
          setBlock(resolved);
          setError(resolved ? null : "This transaction is not a mined PoD block.");
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to resolve the block transaction.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [existingBlockKey, route.name, routeBlockKey, snapshotLoading]);

  return {
    block: existingBlock ?? block,
    loading,
    error,
  };
}

function requestStateSignature(request: NormalizedRequest | null) {
  if (!request) {
    return "null";
  }

  return [
    normalizeHex(request.requestId),
    request.status,
    normalizeHex(request.txHash),
    normalizeHex(request.creationTxHash ?? ""),
    normalizeHex(request.minedTxHash ?? ""),
    request.sourceChainId,
    request.targetChainId,
    normalizeHex(request.sourceContract),
    normalizeHex(request.targetContract),
    normalizeHex(request.originalSender),
    normalizeHex(request.sourceRequestId ?? ""),
    normalizeHex(request.methodSelector),
    normalizeHex(request.callbackSelector),
    normalizeHex(request.errorSelector),
    request.gasRemote ?? "",
    request.gasLocal ?? "",
    request.isTwoWay ? "1" : "0",
  ].join("|");
}

function requestCompletenessScore(request: NormalizedRequest | null) {
  if (!request) {
    return -1;
  }

  return (
    (request.status === "received" ? 10 : 0) +
    (request.txHash ? 1 : 0) +
    (request.creationTxHash ? 2 : 0) +
    (request.minedTxHash ? 4 : 0) +
    (request.sourceContract ? 2 : 0) +
    (request.targetContract ? 2 : 0) +
    (request.originalSender ? 2 : 0) +
    (request.sourceRequestId ? 1 : 0) +
    (request.methodSelector !== "0x00000000" ? 2 : 0) +
    (request.callbackSelector !== "0x00000000" ? 1 : 0) +
    (request.errorSelector !== "0x00000000" ? 1 : 0) +
    (request.gasRemote !== null ? 2 : 0) +
    (request.gasLocal !== null ? 2 : 0)
  );
}

function preferRequestState(
  current: NormalizedRequest | null,
  candidate: NormalizedRequest | null,
) {
  if (!candidate) {
    return current;
  }

  if (!current) {
    return candidate;
  }

  if (normalizeHex(current.requestId) !== normalizeHex(candidate.requestId)) {
    return candidate;
  }

  const currentSig = requestStateSignature(current);
  const candidateSig = requestStateSignature(candidate);
  if (currentSig === candidateSig) {
    return current;
  }

  const currentScore = requestCompletenessScore(current);
  const candidateScore = requestCompletenessScore(candidate);

  if (candidateScore > currentScore) {
    return candidate;
  }

  if (candidateScore < currentScore) {
    return current;
  }

  if (candidate.status === "received" && current.status !== "received") {
    return candidate;
  }

  return current;
}

function lifecycleStateSignature(lifecycle: RequestLifecycle | null) {
  if (!lifecycle) {
    return "null";
  }

  return [
    requestStateSignature(lifecycle.request),
    lifecycle.outcome,
    normalizeHex(lifecycle.parentRequestId ?? ""),
    normalizeHex(lifecycle.childRequestId ?? ""),
    normalizeHex(lifecycle.sentLog?.txHash ?? ""),
    normalizeHex(lifecycle.receivedLog?.txHash ?? ""),
    normalizeHex(lifecycle.childReceivedLog?.txHash ?? ""),
    ...lifecycle.errors.map(
      (entry) => `${normalizeHex(entry.requestId)}:${entry.phase}:${entry.raw}`,
    ),
    ...lifecycle.stages.map(
      (stage) =>
        `${stage.key}:${stage.status}:${normalizeHex(stage.txHash ?? "")}:${normalizeHex(
          stage.requestId ?? "",
        )}`,
    ),
  ].join("|");
}

function addressTransactionSignature(items: AddressTransactionSummary[]) {
  return items
    .map(
      (item) =>
        `${item.chainSlug}:${normalizeHex(item.hash)}:${item.status}:${item.blockNumber}:${item.timestamp}`,
    )
    .join("|");
}

function useResolvedRequest(
  route: Route,
  existingRequest: NormalizedRequest | null,
  refreshToken: string | null,
) {
  const [request, setRequest] = useState<NormalizedRequest | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const routeRequestKey =
    route.name === "request" ? normalizeHex(route.requestId) : null;
  const currentRequestKey = request ? normalizeHex(request.requestId) : null;
  const existingRequestSig = requestStateSignature(existingRequest);

  useEffect(() => {
    if (route.name !== "request") {
      setRequest(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setRequest((current) => {
      const seeded =
        current && normalizeHex(current.requestId) === routeRequestKey ? current : null;
      return preferRequestState(seeded, existingRequest);
    });
    setLoading(!existingRequest && currentRequestKey !== routeRequestKey);
    setError(null);

    void (async () => {
      try {
        const resolved = await resolveRequestById(route.requestId);
        if (!cancelled) {
          setRequest((current) =>
            preferRequestState(current, resolved),
          );
          setError(resolved ? null : "This request ID could not be resolved from the configured inboxes.");
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to resolve request by ID.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentRequestKey, existingRequestSig, refreshToken, route.name, routeRequestKey]);

  return {
    request: request ?? existingRequest,
    loading,
    error,
  };
}

function useAccountTransactions(address: string | null, refreshToken: string | null) {
  const [transactions, setTransactions] = useState<AddressTransactionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!address) {
      setTransactions([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(transactions.length === 0);
    setError(null);

    void (async () => {
      try {
        const nextTransactions = (
          await Promise.all(
            chainConfigs.map((chain) => fetchAddressTransactions(chain, address)),
          )
        )
          .flat()
          .sort(
            (left, right) =>
              new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
          );

        if (!cancelled) {
          setTransactions((current) =>
            addressTransactionSignature(current) === addressTransactionSignature(nextTransactions)
              ? current
              : nextTransactions,
          );
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to load account transactions.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address, refreshToken]);

  return { transactions, loading, error };
}

function useTransactionEventLogs(
  chainSlug: ChainSlug | null,
  txHash: string | null,
  enabled: boolean,
) {
  const [logs, setLogs] = useState<TransactionLog[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !chainSlug || !txHash) {
      setLogs(null);
      setLoading(false);
      setError(null);
      return;
    }

    const chain = chainBySlug.get(chainSlug);
    if (!chain) {
      setError("Missing chain configuration.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const nextLogs = await fetchTransactionLogs(chain, txHash);
        if (!cancelled) {
          setLogs(nextLogs);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to fetch transaction logs.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [chainSlug, enabled, txHash]);

  return { logs, loading, error };
}

function useRequestLifecycle(
  request: NormalizedRequest | null,
  refreshToken: string | null,
) {
  const [lifecycle, setLifecycle] = useState<RequestLifecycle | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifecycleKey = request
    ? `${request.chainSlug}:${normalizeHex(request.requestId)}:${normalizeHex(request.txHash)}:${normalizeHex(request.minedTxHash ?? "")}:${request.status}`
    : null;
  const currentLifecycleKey = lifecycle ? requestStateSignature(lifecycle.request) : null;

  useEffect(() => {
    if (!request) {
      setLifecycle(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(!lifecycle || currentLifecycleKey !== requestStateSignature(request));
    setError(null);

    void (async () => {
      try {
        const nextLifecycle = await loadRequestLifecycle(request);
        if (!cancelled) {
          setLifecycle((current) =>
            lifecycleStateSignature(current) === lifecycleStateSignature(nextLifecycle)
              ? current
              : nextLifecycle,
          );
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to load request lifecycle.",
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentLifecycleKey, lifecycleKey, refreshToken]);

  return { lifecycle, loading, error };
}

function InlineCopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await copyToClipboard(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <button className="copy-button" type="button" onClick={() => void handleCopy()}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function ChainPill({ chain }: { chain: ChainConfig }) {
  return (
    <span className="chain-pill">
      <ChainLogo brand={chain.brand} size={20} />
      {chain.shortName}
    </span>
  );
}

function ChainFlow({
  sourceChainId,
  targetChainId,
}: {
  sourceChainId: number;
  targetChainId: number;
}) {
  const source = chainById.get(sourceChainId);
  const target = chainById.get(targetChainId);

  return (
    <div className="chain-flow">
      <span className="chain-pill compact">
        {source ? <ChainLogo brand={source.brand} size={18} /> : <span className="chain-dot" />}
        {source?.shortName ?? packChainLabel(sourceChainId)}
      </span>
      <span className="chain-arrow">→</span>
      <span className="chain-pill compact">
        {target ? <ChainLogo brand={target.brand} size={18} /> : <span className="chain-dot" />}
        {target?.shortName ?? packChainLabel(targetChainId)}
      </span>
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className="stat-card">
      <span className="eyebrow">{label}</span>
      <strong>{value}</strong>
      <span className="muted-text">{hint}</span>
    </article>
  );
}

function EmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function renderValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry)).join(", ");
  }

  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }

  return String(value);
}

function formatGasValue(value: number | null) {
  return value === null ? "n/a" : formatNumber(value);
}

function lifecycleStatusLabel(status: StageStatus) {
  switch (status) {
    case "success":
      return "Success";
    case "failed":
      return "Failed";
    case "pending":
      return "Pending";
    case "skipped":
      return "Skipped";
    default:
      return "Observed";
  }
}

function stageStatusByKey(
  lifecycle: RequestLifecycle | null,
  key: string,
): StageStatus {
  return lifecycle?.stages.find((stage) => stage.key === key)?.status ?? "pending";
}

type StepperStep = {
  key: string;
  label: string;
  icon: "receive" | "mine" | "shield" | "execute" | "response-mine" | "response-execute";
  status: StageStatus;
};

function buildRequestStepperSteps(
  lifecycle: RequestLifecycle | null,
  request: NormalizedRequest,
): StepperStep[] {
  const steps: StepperStep[] = [
    {
      key: "received",
      label: "Received",
      icon: "receive",
      status: stageStatusByKey(lifecycle, "sent"),
    },
    {
      key: "mined",
      label: "Mined",
      icon: "mine",
      status: stageStatusByKey(lifecycle, "received"),
    },
    {
      key: "validated",
      label: "ValidateCipherText",
      icon: "shield",
      status: stageStatusByKey(lifecycle, "validation"),
    },
    {
      key: "executed",
      label: "Execute",
      icon: "execute",
      status: stageStatusByKey(lifecycle, "remote-execution"),
    },
  ];

  if (request.isTwoWay && !lifecycle?.parentRequestId) {
    const responseMinedStatus =
      lifecycle?.childReceivedLog
        ? "success"
        : lifecycle?.outcome === "execution_failed"
          ? "failed"
          : stageStatusByKey(lifecycle, "response-received");
    const responseExecutedStatus =
      lifecycle?.childSegment?.errorReceived
        ? "failed"
        : lifecycle?.childSegment?.feeExecution
          ? "success"
          : lifecycle?.outcome === "execution_failed"
            ? "failed"
            : stageStatusByKey(lifecycle, "response-execution");

    steps.push(
      {
        key: "response-mined",
        label: "Response Mined",
        icon: "response-mine",
        status: responseMinedStatus,
      },
      {
        key: "response-executed",
        label: "Response Executed",
        icon: "response-execute",
        status: responseExecutedStatus,
      },
    );
  }

  return steps;
}

function StepperIcon({
  icon,
  status,
}: {
  icon: StepperStep["icon"];
  status: StageStatus;
}) {
  const className = cn("request-step-icon", `step-icon-${status}`);

  switch (icon) {
    case "receive":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v10" />
          <path d="M8 10l4 4 4-4" />
          <path d="M5 18h14" />
        </svg>
      );
    case "mine":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 17l6-6" />
          <path d="M11 8l2 2" />
          <path d="M13 6l5 5" />
          <path d="M14 17l6-6" />
          <path d="M3 21h8" />
        </svg>
      );
    case "shield":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3l7 3v5c0 4.4-2.8 8.3-7 10-4.2-1.7-7-5.6-7-10V6l7-3z" />
          <path d="M9.5 12l2 2 3.5-4" />
        </svg>
      );
    case "execute":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M13 4L7 13h4l-1 7 7-10h-4l0-6z" />
        </svg>
      );
    case "response-mine":
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 7h10v10H7z" />
          <path d="M12 3v4" />
          <path d="M8 5l4-2 4 2" />
        </svg>
      );
    default:
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12h10" />
          <path d="M11 6l6 6-6 6" />
          <path d="M5 6v12" />
        </svg>
      );
  }
}

function RequestLifecycleStepper({
  lifecycle,
  request,
}: {
  lifecycle: RequestLifecycle | null;
  request: NormalizedRequest;
}) {
  const steps = buildRequestStepperSteps(lifecycle, request);

  return (
    <section className="panel request-stepper-panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">Quick Progress</span>
          <h2>Request stepper</h2>
          <p>Each step marks whether the request path is complete, failed, or still pending.</p>
        </div>
      </div>
      <div className="request-stepper" role="list" aria-label="Request lifecycle stepper">
        {steps.map((step, index) => (
          <div
            key={step.key}
            role="listitem"
            className={cn("request-step", `request-step-${step.status}`)}
          >
            <div className="request-step-marker">
              <StepperIcon icon={step.icon} status={step.status} />
            </div>
            {index < steps.length - 1 && <div className="request-step-line" aria-hidden="true" />}
            <div className="request-step-copy">
              <strong>{step.label}</strong>
              <span>{lifecycleStatusLabel(step.status)}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function requestOutcomeLabel(lifecycle: RequestLifecycle | null, request: NormalizedRequest) {
  if (request.status === "created" && !request.minedTxHash && !lifecycle?.receivedLog) {
    return "Waiting to be mined";
  }

  if (!lifecycle) {
    return request.isTwoWay ? "Two-way request" : "One-way request";
  }

  if (lifecycle.parentRequestId) {
    return "Return-leg request";
  }

  switch (lifecycle.outcome) {
    case "response":
      return "Response created";
    case "raised_error":
      return "Error response created";
    case "one_way_complete":
      return "Completed with no response";
    case "execution_failed":
      return "Execution failed";
    default:
      return "Lifecycle in progress";
  }
}

function describeOutcome(lifecycle: RequestLifecycle | null, request: NormalizedRequest) {
  if (request.status === "created" && !request.minedTxHash && !lifecycle?.receivedLog) {
    return "The request creation transaction was observed on the source side, but the target inbox has not emitted MessageReceived yet.";
  }

  if (!lifecycle) {
    return request.isTwoWay
      ? "The UI is resolving the response path for this two-way request."
      : "The UI is resolving the target-chain execution for this one-way request.";
  }

  if (lifecycle.parentRequestId) {
    return "This request is the response or error leg created by an earlier root request.";
  }

  switch (lifecycle.outcome) {
    case "response":
      return "The target app emitted a response, creating a new request that travels back to the origin chain.";
    case "raised_error":
      return "The target app raised an application error and emitted a return-leg request for the failure payload.";
    case "one_way_complete":
      return "The target execution completed and no response leg was required.";
    case "execution_failed":
      return "The target execution reverted before a successful response leg could be created.";
    default:
      return "The lifecycle is only partially observed so far from the configured inbox logs.";
  }
}

function RequestLinkButton({
  requestId,
  chainSlug,
  label,
}: {
  requestId: string;
  chainSlug: ChainSlug;
  label: string;
}) {
  return (
    <button
      className="ghost-link button-link"
      type="button"
      onClick={() => navigateTo(`/request/${chainSlug}/${requestId}`)}
    >
      {label}
    </button>
  );
}

function ExplorerAddressLink({
  chain,
  address,
}: {
  chain: ChainConfig | null;
  address: string;
}) {
  if (!chain) {
    return <span>{truncateMiddle(address)}</span>;
  }

  return (
    <a
      className="address-link"
      href={`${chain.explorerBaseUrl}/address/${address}`}
      target="_blank"
      rel="noreferrer"
      title={address}
    >
      {truncateMiddle(address)}
    </a>
  );
}

function StatusBadge({ status }: { status: StageStatus }) {
  return (
    <span className={cn("stage-status", `status-${status}`)}>
      {lifecycleStatusLabel(status)}
    </span>
  );
}

function LifecycleStageCard({
  stage,
  fallbackChainSlug,
}: {
  stage: RequestLifecycle["stages"][number];
  fallbackChainSlug: ChainSlug;
}) {
  return (
    <article className={cn("stage-card", `stage-${stage.status}`)}>
      <div className="stage-head">
        <div>
          <span className="stage-step">Step {stage.step}</span>
          <h3>{stage.title}</h3>
        </div>
        <StatusBadge status={stage.status} />
      </div>
      <p className="stage-note">{stage.note}</p>
      <dl className="raw-grid stage-meta">
        <div>
          <dt>Chain</dt>
          <dd>{stage.chain?.name ?? "Unknown chain"}</dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>{stage.requestId ? formatRequestIdCompact(stage.requestId) : "n/a"}</dd>
        </div>
      </dl>
      <div className="detail-actions stage-actions">
        {stage.txHash && stage.chain && (
          <a
            className="ghost-link"
            href={`${stage.chain.explorerBaseUrl}/tx/${stage.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            Open tx
          </a>
        )}
        {stage.requestId && (
          <RequestLinkButton
            requestId={stage.requestId}
            chainSlug={stage.chain?.slug ?? fallbackChainSlug}
            label="Open request"
          />
        )}
      </div>
      <ul className="detail-list">
        {stage.details.map((detail, index) => (
          <li key={`${stage.key}:${index}`}>{detail}</li>
        ))}
      </ul>
    </article>
  );
}

function EventTimeline({
  title,
  eyebrow,
  description,
  chain,
  txHash,
  logs,
}: {
  title: string;
  eyebrow: string;
  description: string;
  chain: ChainConfig | null;
  txHash: string | null;
  logs: TransactionLog[] | null | undefined;
}) {
  return (
    <article className="panel">
      <div className="panel-header">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {chain && txHash && (
          <a
            className="ghost-link"
            href={`${chain.explorerBaseUrl}/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            Open tx
          </a>
        )}
      </div>
      {!logs?.length && (
        <p className="panel-message">No decoded logs were reconstructed for this segment yet.</p>
      )}
      {logs?.length ? (
        <div className="timeline">
          {logs.map((log) => (
            <article key={`${log.transaction_hash}:${log.index}`} className="timeline-item">
              <div className="timeline-index">{log.index}</div>
              <div className="timeline-body">
                <div className="timeline-head">
                  <strong>{log.decoded?.method_call ?? "Raw log"}</strong>
                  <span className="muted-text">
                    {log.address.name ?? truncateMiddle(log.address.hash)}
                  </span>
                </div>
                <dl className="timeline-params">
                  {log.decoded?.parameters.map((parameter) => (
                    <div key={`${log.index}:${parameter.name}`}>
                      <dt>{parameter.name}</dt>
                      <dd>{truncateMiddle(renderValue(parameter.value), 28, 16)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function HomePage({
  snapshot,
}: {
  snapshot: ExplorerSnapshot;
}) {
  const latestBlocks = snapshot.blocks.slice(0, 8);
  const latestRequests = snapshot.requests.slice(0, 10);
  const totalRequests = snapshot.requests.length;
  const totalBlocks = snapshot.blocks.length;
  const avgPerBlock =
    totalBlocks === 0 ? "0" : (totalRequests / totalBlocks).toFixed(1);

  return (
    <main className="page page-home">
      <section className="hero">
        <div className="hero-copy">
          <span className="hero-tag">Privacy on Demand explorer</span>
          <h1>Track mined blocks and cross-chain requests across PoD inboxes.</h1>
          <p>
            Blocks are the `batchProcessRequests(...)` transactions on each target
            chain. Requests are the `MessageReceived` events grouped under those mined
            block transactions.
          </p>
        </div>
        <div className="hero-panel">
          <div className="hero-grid">
            <StatCard
              label="Latest Mined Blocks"
              value={formatNumber(totalBlocks)}
              hint="Grouped by mined PoD tx hash"
            />
            <StatCard
              label="Tracked Requests"
              value={formatNumber(totalRequests)}
              hint="Cross-chain request entries in the current UI window"
            />
            <StatCard
              label="Active Chains"
              value={formatNumber(snapshot.chains.length)}
              hint="Configured inboxes"
            />
            <StatCard
              label="Avg Requests / Block"
              value={avgPerBlock}
              hint="Across the current lookback set"
            />
          </div>
        </div>
      </section>

      <section className="board">
        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Latest Blocks</span>
              <h2>Mined request batches</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table className="explorer-table">
              <thead>
                <tr>
                  <th>Block Tx</th>
                  <th>Route</th>
                  <th>Requests</th>
                  <th>Target Chain</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {latestBlocks.map((block) => (
                  <tr
                    key={`${block.chainSlug}:${block.txHash}`}
                    className="interactive-row"
                    onClick={() =>
                      navigateTo(`/block/${block.chainSlug}/${block.txHash}`)
                    }
                  >
                    <td>
                      <div className="cell-stack">
                        <strong>{truncateMiddle(block.txHash, 10, 8)}</strong>
                        <span className="muted-text">
                          Block #{formatNumber(block.blockNumber)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <ChainFlow
                        sourceChainId={block.sourceChainId}
                        targetChainId={block.targetChainId}
                      />
                    </td>
                    <td>{formatNumber(block.requestCount)}</td>
                    <td>{chainById.get(block.targetChainId)?.name ?? block.targetChainId}</td>
                    <td>{formatRelative(block.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Latest Requests</span>
              <h2>Fresh PoD request entries</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table className="explorer-table">
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Route</th>
                  <th>Gas Remote</th>
                  <th>Gas Local</th>
                  <th>Age</th>
                </tr>
              </thead>
              <tbody>
                {latestRequests.map((request) => (
                  <tr
                    key={request.requestId}
                    className="interactive-row"
                    onClick={() =>
                      navigateTo(`/request/${request.chainSlug}/${request.requestId}`)
                    }
                  >
                    <td>
                      <div className="cell-stack">
                        <strong>{formatRequestIdCompact(request.requestId)}</strong>
                        <span className="muted-text">
                          Nonce #{formatNumber(request.requestNonce)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <ChainFlow
                        sourceChainId={request.sourceChainId}
                        targetChainId={request.targetChainId}
                      />
                    </td>
                    <td>{formatGasValue(request.gasRemote)}</td>
                    <td>{formatGasValue(request.gasLocal)}</td>
                    <td>{formatRelative(request.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="config-grid">
        {snapshot.chains.map(({ chain, blocks, requests }) => (
          <article key={chain.slug} className="panel chain-card">
            <div className="panel-header">
              <div className="chain-card-heading">
                <ChainPill chain={chain} />
                <div>
                  <h2>{chain.name}</h2>
                  <p>{chain.network}</p>
                </div>
              </div>
            </div>
            <dl className="config-list">
              <div>
                <dt>Chain ID</dt>
                <dd>{chain.id}</dd>
              </div>
              <div>
                <dt>Inbox Contract</dt>
                <dd title={chain.inboxAddress}>{truncateMiddle(chain.inboxAddress)}</dd>
              </div>
              <div>
                <dt>Blockscout API</dt>
                <dd title={chain.apiBaseUrl}>{chain.apiBaseUrl}</dd>
              </div>
              <div>
                <dt>Message Topic</dt>
                <dd title={chain.messageReceivedTopic}>
                  {truncateMiddle(chain.messageReceivedTopic, 14, 8)}
                </dd>
              </div>
              <div>
                <dt>Lookback N</dt>
                <dd>{chain.lookbackLogs} logs</dd>
              </div>
              <div>
                <dt>RPC</dt>
                <dd title={chain.rpcUrl}>{chain.rpcUrl}</dd>
              </div>
            </dl>
            <div className="chain-card-footer">
              <span>{formatNumber(blocks.length)} mined blocks</span>
              <span>{formatNumber(requests.length)} requests</span>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}

function BlockPage({
  block,
}: {
  block: BlockSummary;
}) {
  const { logs, loading, error } = useTransactionEventLogs(
    block.chainSlug,
    block.txHash,
    true,
  );
  const chain = chainBySlug.get(block.chainSlug)!;

  return (
    <main className="page">
      <section className="detail-hero">
        <div className="detail-title">
          <span className="eyebrow">PoD Block</span>
          <h1>{truncateMiddle(block.txHash, 14, 10)}</h1>
          <p>
            This PoD block is a mined `batchProcessRequests(...)` transaction on{" "}
            {chain.name}. It executed {formatNumber(block.requestCount)} request
            {block.requestCount === 1 ? "" : "s"} from{" "}
            {packChainLabel(block.sourceChainId)}.
          </p>
        </div>
        <div className="detail-actions">
          <InlineCopyButton value={block.txHash} />
          <a
            className="ghost-link"
            href={`${chain.explorerBaseUrl}/tx/${block.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            View on Blockscout
          </a>
        </div>
      </section>

      <section className="summary-grid">
        <article className="panel summary-card">
          <span className="eyebrow">Cross-chain Route</span>
          <ChainFlow
            sourceChainId={block.sourceChainId}
            targetChainId={block.targetChainId}
          />
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Execution</span>
          <strong>{formatNumber(block.gasUsed)} gas used</strong>
          <span className="muted-text">Status: {block.status}</span>
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Block Height</span>
          <strong>#{formatNumber(block.blockNumber)}</strong>
          <span className="muted-text">{formatDateTime(block.timestamp)}</span>
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Request Count</span>
          <strong>{formatNumber(block.requestCount)}</strong>
          <span className="muted-text">Grouped by `MessageReceived` logs</span>
        </article>
      </section>

      <section className="board detail-board">
        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Requests In Block</span>
              <h2>Mined request list</h2>
            </div>
          </div>
          <div className="table-scroll">
            <table className="explorer-table">
              <thead>
                <tr>
                  <th>Request ID</th>
                  <th>Route</th>
                  <th>Remote Gas</th>
                  <th>Local Gas</th>
                  <th>Mode</th>
                </tr>
              </thead>
              <tbody>
                {block.requests.map((request) => (
                  <tr
                    key={request.requestId}
                    className="interactive-row"
                    onClick={() =>
                      navigateTo(`/request/${request.chainSlug}/${request.requestId}`)
                    }
                  >
                    <td>
                      <div className="cell-stack">
                        <strong>{formatRequestIdCompact(request.requestId)}</strong>
                        <span className="muted-text">
                          Target {truncateMiddle(request.targetContract)}
                        </span>
                      </div>
                    </td>
                    <td>
                      <ChainFlow
                        sourceChainId={request.sourceChainId}
                        targetChainId={request.targetChainId}
                      />
                    </td>
                    <td>{formatGasValue(request.gasRemote)}</td>
                    <td>{formatGasValue(request.gasLocal)}</td>
                    <td>{request.isTwoWay ? "Two-way" : "One-way"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Execution Log Timeline</span>
              <h2>Decoded contract events</h2>
            </div>
          </div>
          {loading && <p className="panel-message">Loading transaction logs...</p>}
          {error && <p className="panel-message error-text">{error}</p>}
          {!loading && !error && logs && (
            <div className="timeline">
              {logs.map((log) => (
                <article key={`${log.transaction_hash}:${log.index}`} className="timeline-item">
                  <div className="timeline-index">{log.index}</div>
                  <div className="timeline-body">
                    <div className="timeline-head">
                      <strong>{log.decoded?.method_call ?? "Raw log"}</strong>
                      <span className="muted-text">
                        {log.address.name ?? truncateMiddle(log.address.hash)}
                      </span>
                    </div>
                    <dl className="timeline-params">
                      {log.decoded?.parameters.map((parameter) => (
                        <div key={`${log.index}:${parameter.name}`}>
                          <dt>{parameter.name}</dt>
                          <dd>{truncateMiddle(renderValue(parameter.value), 24, 14)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function RequestPage({
  request,
  relatedBlock,
  refreshToken,
}: {
  request: NormalizedRequest;
  relatedBlock: BlockSummary | null;
  refreshToken: string | null;
}) {
  const decoded = unpackRequestId(request.requestId);
  const { lifecycle, loading, error } = useRequestLifecycle(request, refreshToken);
  const routeSource = lifecycle?.originChain ?? chainById.get(request.sourceChainId) ?? null;
  const routeTarget =
    lifecycle?.targetChain ??
    chainById.get(request.targetChainId) ??
    (relatedBlock ? chainBySlug.get(relatedBlock.chainSlug) ?? null : null);
  const sourceRequest = lifecycle?.parentRequest;
  const responseRequest = lifecycle?.childRequest;
  const targetExplorerTx = request.minedTxHash ?? lifecycle?.receivedLog?.txHash ?? null;
  const sourceSendExplorerTx =
    lifecycle?.sentLog?.txHash ?? request.creationTxHash ?? null;
  const creationExplorerTx = request.creationTxHash ?? request.txHash ?? null;
  const displayGasRemote = lifecycle?.parentRequestId ? null : request.gasRemote;
  const displayGasLocal = lifecycle?.parentRequest
    ? lifecycle.parentRequest.gasLocal
    : request.gasLocal;

  return (
    <main className="page">
      <section className="detail-hero">
        <div className="detail-title">
          <span className="eyebrow">PoD Request</span>
          <h1>{formatRequestIdCompact(request.requestId)}</h1>
          <p>
            This page traces the full request lifecycle across the PoD inboxes:
            source send, target receive, validation, execution, and any linked
            response or error leg that travels back to the origin chain.
          </p>
        </div>
        <div className="detail-actions">
          <InlineCopyButton value={request.requestId} />
          <a
            className="ghost-link"
            href={
              creationExplorerTx && routeSource
                ? `${routeSource.explorerBaseUrl}/tx/${creationExplorerTx}`
                : "#"
            }
            target="_blank"
            rel="noreferrer"
            aria-disabled={!creationExplorerTx || !routeSource}
          >
            Open creation tx
          </a>
          {sourceSendExplorerTx && sourceSendExplorerTx !== creationExplorerTx && routeSource && (
            <a
              className="ghost-link"
              href={`${routeSource.explorerBaseUrl}/tx/${sourceSendExplorerTx}`}
              target="_blank"
              rel="noreferrer"
            >
              Open source send tx
            </a>
          )}
          <a
            className="ghost-link"
            href={
              targetExplorerTx && routeTarget
                ? `${routeTarget.explorerBaseUrl}/tx/${targetExplorerTx}`
                : "#"
            }
            target="_blank"
            rel="noreferrer"
            aria-disabled={!targetExplorerTx || !routeTarget}
          >
            {request.minedTxHash || lifecycle?.receivedLog ? "Open mined tx" : "Open latest tx"}
          </a>
          {relatedBlock && (
            <button
              className="ghost-link button-link"
              type="button"
              onClick={() =>
                navigateTo(`/block/${relatedBlock.chainSlug}/${relatedBlock.txHash}`)
              }
            >
              Open Related Block
            </button>
          )}
          {sourceRequest && (
            <RequestLinkButton
              requestId={sourceRequest.requestId}
              chainSlug={sourceRequest.chainSlug}
              label="Open source request"
            />
          )}
          {responseRequest && (
            <RequestLinkButton
              requestId={responseRequest.requestId}
              chainSlug={responseRequest.chainSlug}
              label="Open response request"
            />
          )}
        </div>
      </section>

      <section className="summary-grid">
        <article className="panel summary-card">
          <span className="eyebrow">Route</span>
          <ChainFlow
            sourceChainId={request.sourceChainId}
            targetChainId={request.targetChainId}
          />
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Lifecycle Outcome</span>
          <strong>{requestOutcomeLabel(lifecycle, request)}</strong>
          <span className="muted-text">{describeOutcome(lifecycle, request)}</span>
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Gas Budgets</span>
          <strong>{formatGasValue(displayGasRemote)} remote</strong>
          <span className="muted-text">{formatGasValue(displayGasLocal)} local</span>
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Packed Request ID</span>
          <strong>
            {packChainLabel(decoded.chainId)} · nonce {formatNumber(decoded.nonce)}
          </strong>
          <span className="muted-text">{formatDateTime(request.timestamp)}</span>
        </article>
      </section>

      <RequestLifecycleStepper lifecycle={lifecycle} request={request} />

      <section className="request-hero-grid">
        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Request Overview</span>
              <h2>Cross-chain identity</h2>
            </div>
          </div>
          <div className="request-overview">
            <div className="overview-row">
              <span>Status</span>
              <strong>
                {request.status === "received"
                  ? "Mined on target chain"
                  : "Created on source chain"}
              </strong>
            </div>
            <div className="overview-row">
              <span>Request Role</span>
              <strong>{lifecycle?.parentRequestId ? "Response / error leg" : "Direct request"}</strong>
            </div>
            <div className="overview-row">
              <span>Source Chain</span>
              <strong>{routeSource?.name ?? packChainLabel(request.sourceChainId)}</strong>
            </div>
            <div className="overview-row">
              <span>Target Chain</span>
              <strong>{routeTarget?.name ?? packChainLabel(request.targetChainId)}</strong>
            </div>
            <div className="overview-row">
              <span>Source Contract</span>
              <strong>
                <ExplorerAddressLink
                  chain={routeSource}
                  address={request.sourceContract}
                />
              </strong>
            </div>
            <div className="overview-row">
              <span>Target Contract</span>
              <strong>
                <ExplorerAddressLink
                  chain={routeTarget}
                  address={request.targetContract}
                />
              </strong>
            </div>
            <div className="overview-row">
              <span>Method Selector</span>
              <strong>{request.methodSelector}</strong>
            </div>
            <div className="overview-row">
              <span>Error Selector</span>
              <strong>{request.errorSelector}</strong>
            </div>
            <div className="overview-row">
              <span>Source Request</span>
              <strong>
                {lifecycle?.parentRequestId
                  ? formatRequestIdCompact(lifecycle.parentRequestId)
                  : "Not a response request"}
              </strong>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Lifecycle Readout</span>
              <h2>What happened to this request</h2>
            </div>
          </div>
          <div className="placeholder-stack">
            <article className="placeholder-card">
              <strong>Lifecycle state</strong>
              <p>{describeOutcome(lifecycle, request)}</p>
            </article>
            <article className="placeholder-card">
              <strong>Response tracking</strong>
              <p>
                {lifecycle?.childRequestId
                  ? `A ResponseReceived or RaiseReceived event was joined with MessageSent logs in the same transaction, producing response request ${formatRequestIdCompact(
                      lifecycle.childRequestId,
                    )}.`
                  : lifecycle?.parentRequestId
                    ? `This request is a response to source request ${formatRequestIdCompact(
                        lifecycle.parentRequestId,
                      )}.`
                    : request.isTwoWay
                      ? "No response or error request has been confirmed yet."
                      : "This one-way request does not require a response leg."}
              </p>
            </article>
            <article className="placeholder-card">
              <strong>Error analysis</strong>
              <p>
                {lifecycle?.errors.length
                  ? `${lifecycle.errors.length} error event${
                      lifecycle.errors.length === 1 ? "" : "s"
                    } decoded from inbox logs.`
                  : "No ErrorReceived events were observed for this request path."}
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="panel lifecycle-panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Lifecycle</span>
            <h2>Request execution stages</h2>
            <p>
              Stages are reconstructed from inbox event logs and linked request IDs
              across the configured chains.
            </p>
          </div>
        </div>
        {loading && <p className="panel-message">Resolving lifecycle across both inbox contracts...</p>}
        {error && <p className="panel-message error-text">{error}</p>}
        {!loading && !error && lifecycle && (
          <div className="lifecycle-grid">
            {lifecycle.stages.map((stage) => (
              <LifecycleStageCard
                key={stage.key}
                stage={stage}
                fallbackChainSlug={request.chainSlug}
              />
            ))}
          </div>
        )}
        {!loading && !error && !lifecycle && (
          <p className="panel-message">
            Lifecycle details are not available yet for this request.
          </p>
        )}
      </section>

      {!!lifecycle?.errors.length && (
        <section className="panel raw-panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Errors</span>
              <h2>Decoded failure details</h2>
              <p>
                Error payloads are decoded from `ErrorReceived` logs whenever the
                inbox recorded a revert.
              </p>
            </div>
          </div>
          <div className="error-grid">
            {lifecycle.errors.map((entry) => (
              <article key={`${entry.phase}:${entry.requestId}`} className="error-card">
                <div className="error-head">
                  <strong>{entry.phase}</strong>
                  <StatusBadge status="failed" />
                </div>
                <p>{entry.description}</p>
                <dl className="raw-grid">
                  <div>
                    <dt>Error Code</dt>
                    <dd>
                      {entry.code === null
                        ? "Unknown"
                        : `${entry.code} · ${entry.codeLabel}`}
                    </dd>
                  </div>
                  <div>
                    <dt>Error Selector</dt>
                    <dd>{entry.selector ?? "Not available"}</dd>
                  </div>
                  <div>
                    <dt>Request ID</dt>
                    <dd>{formatRequestIdCompact(entry.requestId)}</dd>
                  </div>
                  <div>
                    <dt>Raw Payload</dt>
                    <dd>{truncateMiddle(entry.raw, 28, 16)}</dd>
                  </div>
                </dl>
                {!!entry.details.length && (
                  <ul className="detail-list">
                    {entry.details.map((detail, index) => (
                      <li key={`${entry.phase}:${entry.requestId}:${index}`}>{detail}</li>
                    ))}
                  </ul>
                )}
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="board detail-board evidence-grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Source Request</span>
              <h2>Request this one responds to</h2>
              <p>
                A non-null `sourceRequestId` means the current request is a response
                or error leg for an earlier request.
              </p>
            </div>
          </div>
          {sourceRequest ? (
            <div className="request-overview">
              <div className="overview-row">
                <span>Request ID</span>
                <strong>{formatRequestIdCompact(sourceRequest.requestId)}</strong>
              </div>
              <div className="overview-row">
                <span>Status</span>
                <strong>
                  {sourceRequest.status === "received"
                    ? "Mined on target chain"
                    : "Created on source chain"}
                </strong>
              </div>
              <div className="overview-row">
                <span>Mined Tx</span>
                <strong>{sourceRequest.minedTxHash ?? "Not mined yet"}</strong>
              </div>
              <div className="detail-actions stage-actions">
                <RequestLinkButton
                  requestId={sourceRequest.requestId}
                  chainSlug={sourceRequest.chainSlug}
                  label="Open source request"
                />
              </div>
            </div>
          ) : (
            <p className="panel-message">This request is not marked as a response to another request.</p>
          )}
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Response Request</span>
              <h2>Request created in response to this one</h2>
              <p>
                When `ResponseReceived` or `RaiseReceived` appears in this request&apos;s
                execution logs, the response request is identified by joining the
                `MessageSent` entries from the same transaction through `sourceRequestId`.
              </p>
            </div>
          </div>
          {responseRequest ? (
            <div className="request-overview">
              <div className="overview-row">
                <span>Request ID</span>
                <strong>{formatRequestIdCompact(responseRequest.requestId)}</strong>
              </div>
              <div className="overview-row">
                <span>Status</span>
                <strong>
                  {responseRequest.status === "received"
                    ? "Mined on target chain"
                    : "Created on source chain"}
                </strong>
              </div>
              <div className="overview-row">
                <span>Creation Tx</span>
                <strong>{responseRequest.creationTxHash ?? responseRequest.txHash}</strong>
              </div>
              <div className="overview-row">
                <span>Mined Tx</span>
                <strong>{responseRequest.minedTxHash ?? "Not mined yet"}</strong>
              </div>
              <div className="detail-actions stage-actions">
                <RequestLinkButton
                  requestId={responseRequest.requestId}
                  chainSlug={responseRequest.chainSlug}
                  label="Open response request"
                />
              </div>
            </div>
          ) : (
            <p className="panel-message">
              No response request has been linked from `ResponseReceived` / `RaiseReceived` and same-tx `MessageSent` logs yet.
            </p>
          )}
        </article>
      </section>

      <section className="board detail-board evidence-grid">
        <EventTimeline
          title="Target-chain request logs"
          eyebrow="Execution Evidence"
          description="Decoded logs from the mined target-chain transaction, scoped to this request segment."
          chain={routeTarget}
          txHash={lifecycle?.requestSegment?.txHash ?? lifecycle?.receivedLog?.txHash ?? request.minedTxHash ?? null}
          logs={lifecycle?.requestSegment?.logs}
        />
        <EventTimeline
          title="Return-leg logs"
          eyebrow="Response Evidence"
          description="Decoded logs for the linked response or error request back on the source chain."
          chain={routeSource}
          txHash={lifecycle?.childSegment?.txHash ?? lifecycle?.childReceivedLog?.txHash ?? null}
          logs={lifecycle?.childSegment?.logs}
        />
      </section>

      <section className="panel raw-panel">
        <div className="panel-header">
          <div>
            <span className="eyebrow">Raw Request Fields</span>
            <h2>Low-level data</h2>
          </div>
        </div>
        <dl className="raw-grid">
          <div>
            <dt>Request ID</dt>
            <dd>{request.requestId}</dd>
          </div>
          <div>
            <dt>Creation Tx</dt>
            <dd>{creationExplorerTx ?? "Not available"}</dd>
          </div>
          <div>
            <dt>Mined Tx</dt>
            <dd>{request.minedTxHash ?? lifecycle?.receivedLog?.txHash ?? "Not mined yet"}</dd>
          </div>
          <div>
            <dt>Source Send Tx</dt>
            <dd>{sourceSendExplorerTx ?? "Not available"}</dd>
          </div>
          <div>
            <dt>Target Chain Explorer</dt>
            <dd>{routeTarget?.explorerBaseUrl ?? "Unavailable"}</dd>
          </div>
          <div>
            <dt>Method Data Preview</dt>
            <dd>{truncateMiddle(request.methodDataPreview, 48, 24)}</dd>
          </div>
          <div>
            <dt>Related Block Tx</dt>
            <dd>{relatedBlock?.txHash ?? lifecycle?.receivedLog?.txHash ?? request.minedTxHash ?? "Not mined yet"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

function requestMatchReasons(request: NormalizedRequest, address: string) {
  const normalizedAddress = normalizeHex(address);
  const reasons: string[] = [];

  if (normalizeHex(request.originalSender) === normalizedAddress) {
    reasons.push("Original sender");
  }

  if (normalizeHex(request.sourceContract) === normalizedAddress) {
    reasons.push("Source contract");
  }

  if (normalizeHex(request.targetContract) === normalizedAddress) {
    reasons.push("Target contract");
  }

  return reasons;
}

function AccountPage({
  address,
  requests,
  transactions,
  transactionsLoading,
  transactionsError,
}: {
  address: string;
  requests: NormalizedRequest[];
  transactions: AddressTransactionSummary[];
  transactionsLoading: boolean;
  transactionsError: string | null;
}) {
  const touchedChains = new Set<ChainSlug>();
  for (const request of requests) {
    const source = chainById.get(request.sourceChainId)?.slug;
    const target = chainById.get(request.targetChainId)?.slug;
    if (source) {
      touchedChains.add(source);
    }
    if (target) {
      touchedChains.add(target);
    }
  }
  for (const transaction of transactions) {
    touchedChains.add(transaction.chainSlug);
  }

  return (
    <main className="page">
      <section className="detail-hero">
        <div className="detail-title">
          <span className="eyebrow">Account</span>
          <h1>{truncateMiddle(address, 12, 10)}</h1>
          <p>
            This page tracks matching PoD requests from the current UI snapshot and
            recent explorer transactions where this address appears as the sender or recipient.
          </p>
        </div>
        <div className="detail-actions">
          <InlineCopyButton value={address} />
          {chainConfigs.map((chain) => (
            <a
              key={chain.slug}
              className="ghost-link"
              href={`${chain.explorerBaseUrl}/address/${address}`}
              target="_blank"
              rel="noreferrer"
            >
              Open on {chain.shortName}
            </a>
          ))}
        </div>
      </section>

      <section className="summary-grid">
        <article className="panel summary-card">
          <span className="eyebrow">Matching Requests</span>
          <strong>{formatNumber(requests.length)}</strong>
          <span className="muted-text">Current client-side request window</span>
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Transactions</span>
          <strong>{formatNumber(transactions.length)}</strong>
          <span className="muted-text">Recent explorer tx history across chains</span>
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Chains Touched</span>
          <strong>{formatNumber(touchedChains.size)}</strong>
          <span className="muted-text">Across requests and transactions</span>
        </article>
        <article className="panel summary-card">
          <span className="eyebrow">Address</span>
          <strong>{truncateMiddle(address, 10, 8)}</strong>
          <span className="muted-text">Cross-chain account lookup</span>
        </article>
      </section>

      <section className="board detail-board">
        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Requests</span>
              <h2>Matching PoD request entries</h2>
              <p>
                Requests are matched when this address appears as the original sender,
                source contract, or target contract in the request data.
              </p>
            </div>
          </div>
          {!requests.length && (
            <p className="panel-message">
              No matching requests were found in the current client-side lookback window.
            </p>
          )}
          {!!requests.length && (
            <div className="table-scroll">
              <table className="explorer-table">
                <thead>
                  <tr>
                    <th>Request ID</th>
                    <th>Route</th>
                    <th>Matched Fields</th>
                    <th>Status</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => (
                    <tr
                      key={request.requestId}
                      className="interactive-row"
                      onClick={() =>
                        navigateTo(`/request/${request.chainSlug}/${request.requestId}`)
                      }
                    >
                      <td>
                        <div className="cell-stack">
                          <strong>{formatRequestIdCompact(request.requestId)}</strong>
                          <span className="muted-text">{truncateMiddle(request.originalSender, 10, 8)}</span>
                        </div>
                      </td>
                      <td>
                        <ChainFlow
                          sourceChainId={request.sourceChainId}
                          targetChainId={request.targetChainId}
                        />
                      </td>
                      <td>{requestMatchReasons(request, address).join(", ")}</td>
                      <td>
                        {request.status === "received"
                          ? "Mined on target chain"
                          : "Created on source chain"}
                      </td>
                      <td>{formatRelative(request.timestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-header">
            <div>
              <span className="eyebrow">Transactions</span>
              <h2>Explorer transaction history</h2>
              <p>Transactions where this address appears as `from` or `to` on the configured chains.</p>
            </div>
          </div>
          {transactionsLoading && (
            <p className="panel-message">Loading account transactions from the configured explorers...</p>
          )}
          {transactionsError && <p className="panel-message error-text">{transactionsError}</p>}
          {!transactionsLoading && !transactionsError && !transactions.length && (
            <p className="panel-message">No matching transactions were found for this address.</p>
          )}
          {!!transactions.length && (
            <div className="table-scroll">
              <table className="explorer-table">
                <thead>
                  <tr>
                    <th>Tx Hash</th>
                    <th>Chain</th>
                    <th>Method</th>
                    <th>Direction</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {transactions.map((transaction) => {
                    const chain = chainBySlug.get(transaction.chainSlug)!;
                    const normalizedAddress = normalizeHex(address);
                    const direction =
                      normalizeHex(transaction.from) === normalizedAddress
                        ? normalizeHex(transaction.to ?? "") === normalizedAddress
                          ? "Self"
                          : "Outgoing"
                        : "Incoming";

                    return (
                      <tr
                        key={`${transaction.chainSlug}:${transaction.hash}`}
                        className="interactive-row"
                        onClick={() => window.open(`${chain.explorerBaseUrl}/tx/${transaction.hash}`, "_blank")}
                      >
                        <td>
                          <div className="cell-stack">
                            <strong>{truncateMiddle(transaction.hash, 12, 8)}</strong>
                            <span className="muted-text">
                              {transaction.status === "ok" ? "Confirmed" : "Failed"}
                            </span>
                          </div>
                        </td>
                        <td>
                          <ChainPill chain={chain} />
                        </td>
                        <td>{transaction.method}</td>
                        <td>{direction}</td>
                        <td>{formatRelative(transaction.timestamp)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

export function App() {
  const route = useHashRoute();
  const { snapshot, loading, error, reload } = useExplorerSnapshotState();
  const [searchValue, setSearchValue] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchNotice, setSearchNotice] = useState<string | null>(null);

  useEffect(() => {
    setSearchValue("");
  }, [route]);

  const blockMap = new Map<string, BlockSummary>();
  const requestMap = new Map<string, NormalizedRequest>();

  if (snapshot) {
    for (const block of snapshot.blocks) {
      blockMap.set(`${block.chainSlug}:${normalizeHex(block.txHash)}`, block);
    }

    for (const request of snapshot.requests) {
      requestMap.set(normalizeHex(request.requestId), request);
    }
  }

  const routeBlock =
    route.name === "block"
      ? blockMap.get(`${route.chainSlug}:${normalizeHex(route.txHash)}`) ?? null
      : null;
  const { block: resolvedBlock, loading: blockLoading, error: blockError } =
    useResolvedBlock(route, routeBlock, loading);

  const routeRequest =
    route.name === "request"
      ? requestMap.get(normalizeHex(route.requestId)) ?? null
      : null;
  const {
    request: resolvedRequest,
    loading: requestLoading,
    error: requestError,
  } = useResolvedRequest(route, routeRequest, snapshot?.generatedAt ?? null);
  const accountAddress = route.name === "account" ? route.address : null;
  const accountRequests = snapshot
    ? snapshot.requests
        .filter((request) => requestMatchReasons(request, accountAddress ?? "").length > 0)
        .sort(
          (left, right) =>
            new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
        )
    : [];
  const {
    transactions: accountTransactions,
    loading: accountTransactionsLoading,
    error: accountTransactionsError,
  } = useAccountTransactions(accountAddress, snapshot?.generatedAt ?? null);
  const relatedBlock =
    resolvedRequest
      ? snapshot?.blocks.find(
          (candidate) =>
            normalizeHex(candidate.txHash) ===
            normalizeHex(resolvedRequest.minedTxHash ?? ""),
        ) ?? null
      : null;

  async function handleSearch(event: FormEvent) {
    event.preventDefault();
    const query = searchValue.trim();
    if (!query) {
      return;
    }

    setSearchNotice(null);
    const normalized = normalizeHex(query);

    if (isAddress(query)) {
      navigateTo(`/account/${query}`);
      return;
    }

    const request = requestMap.get(normalized);
    if (request) {
      navigateTo(`/request/${request.chainSlug}/${request.requestId}`);
      return;
    }

    const loadedBlock =
      snapshot?.blocks.find((candidate) => normalizeHex(candidate.txHash) === normalized) ??
      null;
    if (loadedBlock) {
      navigateTo(`/block/${loadedBlock.chainSlug}/${loadedBlock.txHash}`);
      return;
    }

    setSearchBusy(true);

    try {
      const remoteRequest = await resolveRequestById(normalized);
      if (remoteRequest) {
        navigateTo(`/request/${remoteRequest.chainSlug}/${remoteRequest.requestId}`);
        setSearchNotice("Request matched directly from the explorer API.");
        return;
      }

      const requestFromTx = await resolveRequestFromTransaction(normalized);
      if (requestFromTx) {
        navigateTo(`/request/${requestFromTx.chainSlug}/${requestFromTx.requestId}`);
        setSearchNotice("Creation transaction matched a PoD request.");
        return;
      }

      const remoteMatch = await resolveBlockTransaction(normalized);
      if (remoteMatch) {
        navigateTo(`/block/${remoteMatch.chain.slug}/${remoteMatch.tx.hash}`);
        setSearchNotice("Block matched directly from the explorer API.");
      } else {
        setSearchNotice(
          "No matching request ID or mined PoD block tx was found in the configured inboxes.",
        );
      }
    } catch (nextError) {
      setSearchNotice(
        nextError instanceof Error
          ? nextError.message
          : "Search failed against the chain explorers.",
      );
    } finally {
      setSearchBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand-lockup" type="button" onClick={() => navigateTo("/")}>
          <div className="brand-mark">PoD</div>
          <div>
            <strong>Explorer</strong>
            <span>Privacy on Demand block and request explorer</span>
          </div>
        </button>

        <form className="search-shell" onSubmit={handleSearch}>
          <input
            type="search"
            value={searchValue}
            onChange={(event) => setSearchValue(event.target.value)}
            placeholder="Search request ID, address, creation tx, or mined block tx hash"
            spellCheck={false}
          />
          <button type="submit" disabled={searchBusy}>
            {searchBusy ? "Searching..." : "Search"}
          </button>
        </form>

        <div className="topbar-actions">
          <button className="ghost-link button-link" type="button" onClick={() => void reload()}>
            Refresh
          </button>
        </div>
      </header>

      <section className="status-strip">
        <div className="status-item">
          <span className="eyebrow">Mode</span>
          <strong>UI-only / no backend</strong>
        </div>
        <div className="status-item">
          <span className="eyebrow">Chains</span>
          <div className="pill-row">
            {explorerConfig.chains.map((chain) => (
              <ChainPill key={chain.slug} chain={chain} />
            ))}
          </div>
        </div>
        <div className="status-item grow">
          <span className="eyebrow">Config Note</span>
          <strong>{explorerConfig.lookbackNote}</strong>
        </div>
      </section>

      {searchNotice && <div className="banner">{searchNotice}</div>}
      {error && <div className="banner error">{error}</div>}

      {loading && !snapshot && (
        <main className="page">
          <EmptyState
            title="Loading PoD explorer"
            body="Fetching MessageReceived logs and resolving mined block transactions from the configured inboxes."
          />
        </main>
      )}

      {!loading && !snapshot && !error && (
        <main className="page">
          <EmptyState
            title="No explorer snapshot"
            body="The PoD UI is up, but no chain data was returned."
          />
        </main>
      )}

      {snapshot && route.name === "home" && <HomePage snapshot={snapshot} />}

      {route.name === "account" && (
        <AccountPage
          address={route.address}
          requests={accountRequests}
          transactions={accountTransactions}
          transactionsLoading={accountTransactionsLoading}
          transactionsError={accountTransactionsError}
        />
      )}

      {route.name === "block" && (
        <>
          {blockLoading && !resolvedBlock && (
            <main className="page">
              <EmptyState
                title="Resolving block transaction"
                body="Looking up this tx hash directly against the configured chain explorer."
              />
            </main>
          )}
          {!blockLoading && resolvedBlock && <BlockPage block={resolvedBlock} />}
          {!blockLoading && !resolvedBlock && (
            <main className="page">
              <EmptyState
                title="PoD block not found"
                body={
                  blockError ??
                  "This tx hash is not available in the current snapshot or as a direct mined PoD block lookup."
                }
              />
            </main>
          )}
        </>
      )}

      {route.name === "request" && (
        <>
          {requestLoading && !resolvedRequest && (
            <main className="page">
              <EmptyState
                title="Resolving request"
                body="Looking up this request ID directly against the configured inbox logs."
              />
            </main>
          )}
          {!requestLoading && resolvedRequest && (
            <RequestPage
              request={resolvedRequest}
              relatedBlock={relatedBlock}
              refreshToken={snapshot?.generatedAt ?? null}
            />
          )}
          {!requestLoading && !resolvedRequest && (
            <main className="page">
              <EmptyState
                title="Request not found"
                body={
                  requestError ??
                  "This request ID is outside the current client-side lookback window, or it does not belong to the configured PoD inboxes."
                }
              />
            </main>
          )}
        </>
      )}
    </div>
  );
}
