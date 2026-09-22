"use client";

import type { ReactNode } from "react";
import { WalletProvider } from "../lib/wallet/wallet";

export function Providers({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}
