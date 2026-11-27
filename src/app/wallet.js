import { createConfig, http } from "wagmi";
import { defineChain } from "viem";
import { connectorsForWallets, darkTheme } from "@rainbow-me/rainbowkit";
import {
  coinbaseWallet,
  injectedWallet,
  metaMaskWallet,
  okxWallet,
  rabbyWallet,
  rainbowWallet,
  trustWallet,
  walletConnectWallet,
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

// A WalletConnect (Reown) project ID unlocks mobile and QR wallets. It is public, not a secret.
// Without one, browser-extension wallets still work.
const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "";
const groups = projectId
  ? [
      { groupName: "Popular", wallets: [metaMaskWallet, rabbyWallet, coinbaseWallet, rainbowWallet] },
      { groupName: "More", wallets: [okxWallet, trustWallet, walletConnectWallet, injectedWallet] },
    ]
  : [{ groupName: "Browser wallets", wallets: [injectedWallet, rabbyWallet, coinbaseWallet] }];

export const config = createConfig({
  connectors: connectorsForWallets(groups, { appName: "JellySwarm", projectId: projectId || "browser-only" }),
  chains: [elysium],
  transports: { [elysium.id]: http() },
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
