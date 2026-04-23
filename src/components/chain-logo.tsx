type ChainLogoProps = {
  brand: "coti" | "ethereum";
  size?: number;
};

export function ChainLogo({ brand, size = 28 }: ChainLogoProps) {
  if (brand === "coti") {
    return (
      <svg
        aria-hidden="true"
        className="chain-logo-svg"
        viewBox="0 0 64 64"
        width={size}
        height={size}
      >
        <defs>
          <linearGradient id="cotiGradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#00d4ff" />
            <stop offset="100%" stopColor="#0a84ff" />
          </linearGradient>
        </defs>
        <circle cx="32" cy="32" r="31" fill="url(#cotiGradient)" />
        <path
          d="M36.5 16c8.8 0 16 7.2 16 16s-7.2 16-16 16H23.9v-6.8h12.6a9.2 9.2 0 1 0 0-18.4H23.9v-6.8h12.6Zm-4.2 13.1v5.8H15.5v-5.8h16.8Z"
          fill="#f8fcff"
        />
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className="chain-logo-svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
    >
      <circle cx="32" cy="32" r="31" fill="#eef2ff" />
      <path d="M32 10 20.5 32 32 38.8 43.5 32 32 10Z" fill="#627eea" />
      <path d="M32 41.4 20.5 34.6 32 54 43.5 34.6 32 41.4Z" fill="#8ea2ff" />
      <path d="M32 38.8V10 54" fill="none" stroke="#4057c7" strokeWidth="2.2" />
    </svg>
  );
}
