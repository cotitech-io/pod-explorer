import type { ChainConfig, ChainSlug } from "../types/explorer";

export const MESSAGE_RECEIVED_TOPIC =
  "0x8640cc4eb5cb8fe1cef18587479d948bda9aadb5430414cc590c148389107161";

export const chainConfigs: ChainConfig[] = [
  {
    id: 7082400,
    slug: "coti-testnet",
    name: "COTI Testnet",
    shortName: "COTI",
    network: "Target / source chain for mined MPC execution",
    explorerBaseUrl: "https://testnet.cotiscan.io",
    apiBaseUrl: "https://testnet.cotiscan.io",
    inboxAddress: "0x0f9A5cD00450Db1217839C35D23D56F96d6331AE",
    messageReceivedTopic: MESSAGE_RECEIVED_TOPIC,
    rpcUrl: "https://testnet.coti.io/rpc",
    lookbackLogs: 16,
    accent: "#00c2ff",
    brand: "coti",
  },
  {
    id: 11155111,
    slug: "sepolia",
    name: "Sepolia",
    shortName: "Sepolia",
    network: "Ethereum testnet side of PoD",
    explorerBaseUrl: "https://sepolia.etherscan.io",
    apiBaseUrl: "https://eth-sepolia.blockscout.com",
    inboxAddress: "0xFa158f9e49C8bb77f971c3630EbCD23a8a88D14E",
    messageReceivedTopic: MESSAGE_RECEIVED_TOPIC,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    lookbackLogs: 16,
    accent: "#627eea",
    brand: "ethereum",
  },
];

export const chainBySlug = new Map<ChainSlug, ChainConfig>(
  chainConfigs.map((chain) => [chain.slug, chain]),
);

export const chainById = new Map<number, ChainConfig>(
  chainConfigs.map((chain) => [chain.id, chain]),
);

export const explorerConfig = {
  chains: chainConfigs,
  autoRefreshMs: 60000,
  lookbackNote:
    "Everything is loaded directly in the browser from explorer APIs, with automatic refresh and direct request lookup from the configured inbox logs.",
};
