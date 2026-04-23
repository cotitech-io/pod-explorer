export type ChainSlug = "coti-testnet" | "sepolia";

export type ChainConfig = {
  id: number;
  slug: ChainSlug;
  name: string;
  shortName: string;
  network: string;
  explorerBaseUrl: string;
  apiBaseUrl: string;
  inboxAddress: string;
  messageReceivedTopic: string;
  rpcUrl: string;
  lookbackLogs: number;
  accent: string;
  brand: "coti" | "ethereum";
};

export type LegacyLog = {
  address: string;
  blockNumber: string;
  data: string;
  gasPrice: string;
  gasUsed: string;
  logIndex: string;
  timeStamp: string;
  topics: string[];
  transactionHash: string;
  transactionIndex: string;
};

export type TransactionDetail = {
  hash: string;
  block_number: number;
  status: string;
  timestamp: string;
  gas_used: string;
  gas_price: string;
  method: string;
  fee?: {
    type: string;
    value: string;
  } | null;
  from: {
    hash: string;
  };
  to: {
    hash: string;
    name?: string | null;
  } | null;
  decoded_input?: {
    method_call: string;
    method_id: string;
    parameters: Array<{
      name: string;
      type: string;
      value: unknown;
    }>;
  } | null;
};

export type TransactionLog = {
  index: number;
  transaction_hash: string;
  topics: Array<string | null>;
  data: string;
  address: {
    hash: string;
    name?: string | null;
  };
  decoded?: {
    method_call: string;
    method_id: string;
    parameters: Array<{
      indexed?: boolean;
      name: string;
      type: string;
      value: unknown;
    }>;
  } | null;
};

export type NormalizedRequest = {
  requestId: string;
  txHash: string;
  creationTxHash: string | null;
  minedTxHash: string | null;
  status: "created" | "received";
  chainSlug: ChainSlug;
  sourceChainId: number;
  targetChainId: number;
  sourceContract: string;
  targetContract: string;
  originalSender: string;
  sourceRequestId: string | null;
  callbackSelector: string;
  errorSelector: string;
  methodSelector: string;
  methodDataPreview: string;
  gasRemote: number | null;
  gasLocal: number | null;
  isTwoWay: boolean;
  blockNumber: number;
  timestamp: string;
  logIndex: number;
  requestNonce: number;
};

export type AddressTransactionSummary = {
  chainSlug: ChainSlug;
  hash: string;
  timestamp: string;
  blockNumber: number;
  status: string;
  method: string;
  from: string;
  to: string | null;
  value: string;
};

export type BlockSummary = {
  txHash: string;
  chainSlug: ChainSlug;
  sourceChainId: number;
  targetChainId: number;
  blockNumber: number;
  requestCount: number;
  timestamp: string;
  gasUsed: number;
  gasPrice: string;
  feeValue: string;
  status: string;
  method: string;
  from: string;
  to: string;
  requests: NormalizedRequest[];
};

export type ChainSnapshot = {
  chain: ChainConfig;
  blocks: BlockSummary[];
  requests: NormalizedRequest[];
};

export type ExplorerSnapshot = {
  chains: ChainSnapshot[];
  blocks: BlockSummary[];
  requests: NormalizedRequest[];
  generatedAt: string;
};
