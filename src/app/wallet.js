import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { connectorsForWallets, darkTheme } from "@rainbow-me/rainbowkit";
import {
  braveWallet,
  coinbaseWallet,
  metaMaskWallet,
  okxWallet,
  phantomWallet,
  rabbyWallet,
  rainbowWallet,
  trustWallet,
  walletConnectWallet,
  zerionWallet,
} from "@rainbow-me/rainbowkit/wallets";

export const USDC = "0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65";
export const EXPLORER = "https://elysium.kinetiq.xyz/explorer";

export const elysium = defineChain({
  id: 99901,
  name: "Elysium",
  nativeCurrency: { name: "HYPE", symbol: "HYPE", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.elysium.kinetiq.xyz"] } },
  blockExplorers: { default: { name: "Elysium Explorer", url: EXPLORER } },
});

// Every installed extension that announces itself (EIP-6963: MetaMask, Rabby, Rainbow, Phantom, OKX, …)
// is listed under "Installed" with its own name and its own provider, so picking one never falls
// through to whichever extension grabbed window.ethereum. There is deliberately no generic
// "Browser Wallet" entry: that one always opens the extension that owns window.ethereum.
//
// A WalletConnect (Reown) project ID adds mobile and QR-code wallets. It is public, not a secret.
// Without one, installed browser wallets still work.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";
const groups = [
  {
    groupName: "Popular",
    wallets: [metaMaskWallet, rabbyWallet, rainbowWallet, coinbaseWallet, phantomWallet],
  },
  {
    groupName: "More",
    wallets: [okxWallet, trustWallet, zerionWallet, braveWallet, ...(projectId ? [walletConnectWallet] : [])],
  },
];

export const config = createConfig({
  connectors: connectorsForWallets(groups, { appName: "JellySwarm", projectId: projectId || "browser-only" }),
  chains: [elysium],
  transports: { [elysium.id]: http() },
  multiInjectedProviderDiscovery: true,
  ssr: false,
});

export const rkTheme = (() => {
  const t = darkTheme({
    accentColor: "#6ef3cf",
    accentColorForeground: "#0a1f24",
    borderRadius: "large",
    fontStack: "system",
    overlayBlur: "small",
  });
  t.colors.modalBackground = "#0a2630";
  t.colors.modalBorder = "rgba(140,240,220,0.18)";
  t.colors.profileForeground = "#0a2630";
  t.fonts.body = '"DM Sans", system-ui, sans-serif';
  return t;
})();
