"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DecisionRecord,
  ExecutableQuote,
  MarketSnapshot,
  OraDecision,
  OraReasoning,
  UserSettings,
} from "../types/ora";
import {
  CONTRACTS,
  ROBINHOOD_CHAIN_ID,
} from "../lib/orbio/contracts";
import {
  beneficiaryBytes32,
  erc20Abi,
  exchangeAbi,
  publicClient,
  robinhoodChain,
} from "../lib/orbio/exchange";
import { unitsToAtoms } from "../lib/orbio/market";
import { decide, decideWithExecutableQuote } from "../lib/ora/decision";
import {
  canReviewDecision,
  evaluationKey,
  nextEvaluationAction,
  sameMarketEvaluation,
  settingsReadyForEvaluation,
  shouldRequestQuote,
} from "../lib/ora/evaluation";
import { quoteMeetsMinDiscount } from "../lib/ora/quote-rule";
import {
  executionLabel,
  formatCredit,
  formatPrice,
  formatTime,
  recordStage,
  recordStageClass,
} from "../lib/ora/format";
import { classifyTxError } from "../lib/ora/tx-error";
import { useWallet } from "../lib/wallet/wallet";
import { walletSearchParam } from "../lib/ora/wallet";

type AppState =
  | "wallet_disconnected"
  | "connecting"
  | "ready"
  | "market_loading"
  | "market_unavailable"
  | "decision_loading"
  | "buy"
  | "wait"
  | "review"
  | "pending"
  | "success"
  | "failed";

export function OraDeskPage() {
  const {
    address,
    chainId,
    usdgBalance: balanceUsdg,
    nativeBalance,
    refreshBalance,
  } = useWallet();
  const isConnected = Boolean(address);

  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [recorded, setRecorded] = useState<OraDecision | null>(null);
  const [record, setRecord] = useState<DecisionRecord | null>(null);
  const [reasoning, setReasoning] = useState<OraReasoning | null>(null);
  const [reasoningUnavailable, setReasoningUnavailable] = useState(false);
  const [quote, setQuote] = useState<ExecutableQuote | null>(null);
  const [quoteBook, setQuoteBook] = useState<{
    bestDiscount: number;
    availableAtBestDiscount: number;
    creditPrice: number;
  } | null>(null);
  const [history, setHistory] = useState<DecisionRecord[]>([]);
  const [selected, setSelected] = useState<DecisionRecord | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [ui, setUi] = useState<AppState>("market_loading");
  const [refreshing, setRefreshing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<UserSettings | null>(null);
  const saveResetRef = useRef<number | null>(null);
  const lastPersistedKey = useRef<string | null>(null);
  const inFlightKey = useRef<string | null>(null);
  const inFlight = useRef<Promise<DecisionRecord | null> | null>(null);
  const recordRef = useRef<DecisionRecord | null>(null);
  const addressRef = useRef(address);
  const marketRef = useRef(market);
  const persistRef = useRef<
    (expectedKey: string) => Promise<DecisionRecord | null>
  >(async () => null);
  addressRef.current = address;
  marketRef.current = market;

  const liveDecision = useMemo(() => {
    if (!market || !settings) return null;
    return decide(market, settings);
  }, [market, settings]);

  const constrained = useMemo(() => {
    if (!market || !settings || !liveDecision?.requestedAmount || !record?.executable) {
      return null;
    }
    if (!sameMarketEvaluation(record.snapshot, market)) return null;
    if (record.evaluatedSpendingLimitUsdg !== settings.spendingLimitUsdg) {
      return null;
    }
    if (liveDecision.action !== "BUY") return null;
    if (record.executable.requestedCredit !== liveDecision.requestedAmount) {
      return null;
    }
    return decideWithExecutableQuote(market, settings, record.executable);
  }, [market, settings, liveDecision, record]);

  const evaluationMatches =
    recorded != null &&
    address != null &&
    market != null &&
    settings != null &&
    evaluationKey(address, market, settings) === lastPersistedKey.current;
  const formKey =
    address && market && settings
      ? evaluationKey(address, market, settings)
      : null;
  const committedKey =
    address && market && committed
      ? evaluationKey(address, market, committed)
      : null;
  const formDiffers =
    formKey != null && committedKey != null && formKey !== committedKey;
  const evaluationPlan =
    address && market && committed
      ? nextEvaluationAction({
          wallet: address,
          market,
          params: committed,
          lastKey: lastPersistedKey.current,
          inFlightKey: inFlightKey.current,
          latest: record ?? history[0] ?? null,
        })
      : null;
  const latestForPlan = record ?? history[0] ?? null;
  const requoteUncheckedBuy =
    evaluationPlan?.type === "adopt" &&
    latestForPlan?.decision === "BUY" &&
    !latestForPlan.executable &&
    canReviewDecision(latestForPlan);
  const executablePending =
    !formDiffers &&
    liveDecision?.action === "BUY" &&
    constrained == null &&
    !evaluationMatches &&
    (evaluationPlan?.type === "persist" || requoteUncheckedBuy);
  const decision = executablePending
    ? null
    : (constrained ?? (evaluationMatches ? recorded : liveDecision));
  const isBookPreview =
    decision != null && !evaluationMatches && constrained == null;
  const reasoningMatchesDecision =
    decision != null &&
    recorded != null &&
    decision.action === recorded.action;

  const loadMarket = useCallback(async () => {
    setRefreshing(true);
    setMarketError(null);
    try {
      const response = await fetch("/api/market", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) {
        setMarketError(data.error ?? "Market unavailable");
        setUi((prev) => (prev === "market_loading" ? "market_unavailable" : prev));
        return;
      }
      setMarket(data.market);
      setUi((prev) =>
        prev === "market_loading" || prev === "market_unavailable"
          ? "ready"
          : prev,
      );
    } catch (err) {
      setMarketError(
        err instanceof Error ? err.message : "Market unavailable",
      );
      setUi((prev) => (prev === "market_loading" ? "market_unavailable" : prev));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const loadRest = useCallback(async () => {
    const wallet = address;
    const query = walletSearchParam(wallet);
    const [settingsRes, ledgerRes] = await Promise.all([
      fetch(`/api/settings${query}`, { cache: "no-store" }),
      fetch(`/api/ledger${query}`, { cache: "no-store" }),
    ]);
    if (addressRef.current !== wallet) return;
    const settingsJson = await settingsRes.json();
    const ledgerJson = await ledgerRes.json();
    if (!wallet) {
      setSettings(settingsJson.settings ?? null);
      setCommitted(null);
      setHistory(ledgerJson.decisions ?? []);
      return;
    }
    const loaded = settingsJson.settings as UserSettings | undefined;
    if (!loaded || !settingsReadyForEvaluation(wallet, loaded)) return;
    setSettings(loaded);
    setCommitted(loaded);
    setHistory(ledgerJson.decisions ?? []);
  }, [address]);

  useEffect(() => {
    void loadMarket();
    void loadRest();
  }, [loadMarket, loadRest]);

  useEffect(() => {
    return () => {
      if (saveResetRef.current != null) {
        window.clearTimeout(saveResetRef.current);
      }
    };
  }, []);

  async function saveSettings(next: UserSettings) {
    const requestedCredit = Math.max(
      market?.minBuyCredit ?? 5,
      next.requestedCredit,
    );
    const payload = { ...next, requestedCredit, walletAddress: address };
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error ?? "Could not save settings.");
    }
    setSettings(data.settings);
    setCommitted(data.settings);
    setQuote(null);
    setQuoteBook(null);
    return data.settings as UserSettings;
  }

  async function handleSaveParameters(next: UserSettings) {
    setSaveError(null);
    setSaveStatus("saving");
    if (saveResetRef.current != null) {
      window.clearTimeout(saveResetRef.current);
      saveResetRef.current = null;
    }
    try {
      await saveSettings(next);
      setSaveStatus("saved");
      saveResetRef.current = window.setTimeout(() => {
        setSaveStatus("idle");
        saveResetRef.current = null;
      }, 1800);
    } catch (err) {
      setSaveStatus("idle");
      setSaveError(
        err instanceof Error ? err.message : "Could not save settings.",
      );
    }
  }

  function rememberRecord(next: DecisionRecord | null) {
    recordRef.current = next;
    setRecord(next);
  }

  function applyRecordedDecision(
    next: OraDecision,
    ledger: DecisionRecord,
    reasoningResult: OraReasoning | null,
    key: string,
  ) {
    lastPersistedKey.current = key;
    setRecorded(next);
    rememberRecord(ledger);
    setReasoning(reasoningResult);
    setReasoningUnavailable(!reasoningResult);
  }

  async function persistDecision(
    expectedKey: string,
  ): Promise<DecisionRecord | null> {
    const wallet = addressRef.current;
    setError(null);
    if (!wallet) return null;
    setUi("decision_loading");
    const response = await fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? "Decision failed");
      setUi("failed");
      return null;
    }
    if (addressRef.current !== wallet) return null;
    const ledger = data.record as DecisionRecord;
    const nextReasoning =
      ledger.reasoning ?? (data.reasoning as OraReasoning | null) ?? null;
    applyRecordedDecision(
      data.decision as OraDecision,
      ledger,
      nextReasoning,
      expectedKey,
    );
    await loadRest();
    setUi((prev) =>
      prev === "review" || prev === "pending" || prev === "success"
        ? prev
        : data.decision.action === "BUY"
          ? "buy"
          : "wait",
    );
    return ledger;
  }

  persistRef.current = persistDecision;

  const ensureRecorded = useCallback(
    async (
      params: UserSettings,
      force = false,
    ): Promise<DecisionRecord | null> => {
      const wallet = addressRef.current;
      const book = marketRef.current;
      if (!wallet || !book) return null;
      if (!settingsReadyForEvaluation(wallet, params)) return null;
      const key = evaluationKey(wallet, book, params);
      if (inFlight.current && inFlightKey.current === key) {
        return inFlight.current;
      }
      if (inFlight.current && inFlightKey.current !== key) {
        await inFlight.current;
        return ensureRecorded(params, force);
      }
      if (
        !force &&
        key === lastPersistedKey.current &&
        recordRef.current &&
        canReviewDecision(recordRef.current)
      ) {
        return recordRef.current;
      }
      const pending = persistRef.current(key);
      inFlightKey.current = key;
      inFlight.current = pending;
      try {
        return await pending;
      } finally {
        if (inFlight.current === pending) {
          inFlight.current = null;
          inFlightKey.current = null;
        }
      }
    },
    [],
  );

  useEffect(() => {
    lastPersistedKey.current = null;
    inFlightKey.current = null;
    recordRef.current = null;
    setRecord(null);
    setRecorded(null);
    setReasoning(null);
    setReasoningUnavailable(false);
    setCommitted(null);
    setSettings(null);
    setHistory([]);
  }, [address]);

  useEffect(() => {
    if (!settingsReadyForEvaluation(address, committed) || !market || !committed) {
      return;
    }
    const plan = nextEvaluationAction({
      wallet: address,
      market,
      params: committed,
      lastKey: lastPersistedKey.current,
      inFlightKey: inFlightKey.current,
      latest: recordRef.current ?? history[0] ?? null,
    });
    if (plan.type === "skip") return;
    if (plan.type === "adopt") {
      const latest = history[0];
      if (!latest || !canReviewDecision(latest)) return;
      if (latest.decision === "BUY" && !latest.executable) {
        void ensureRecorded(committed, true);
        return;
      }
      applyRecordedDecision(
        {
          action: latest.decision,
          timestamp: latest.timestamp,
          market: latest.snapshot,
          reason: latest.reason,
          requestedAmount: latest.requestedAmount,
          params: committed,
        },
        latest,
        latest.reasoning ?? null,
        plan.key,
      );
      setUi(latest.decision === "BUY" ? "buy" : "wait");
      return;
    }
    void ensureRecorded(committed, true);
  }, [address, market, committed, history, ensureRecorded]);

  async function requestQuote() {
    const current = decision;
    if (!shouldRequestQuote(current?.action)) {
      setError("Ora is not offering a purchase on the current book.");
      setProgress("");
      return;
    }
    if (!address) {
      setError("Connect a wallet before recording a decision.");
      setProgress("");
      setUi("failed");
      return;
    }
    setError(null);
    setProgress("Getting executable quote");
    setTimeout(() => scrollToReview(), 0);
    try {
      const active = settings ? await saveSettings(settings) : null;
      setProgress("Getting executable quote");
      const persisted = active ? await ensureRecorded(active) : null;
      if (!persisted) {
        setProgress("");
        return;
      }
      if (!shouldRequestQuote(persisted.decision)) {
        setProgress("");
        setError(
          persisted.reason ??
            "Ora is not offering a purchase on the current book.",
        );
        setUi("failed");
        return;
      }
      setRecord(persisted);
      const amount =
        current?.requestedAmount ??
        settings?.requestedCredit ??
        market?.minBuyCredit ??
        5;
      const response = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestedCredit: amount,
          decisionId: persisted.id,
          walletAddress: address,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (data.code === "quote_below_threshold" && data.quote) {
          setQuote(data.quote);
          setQuoteBook(data.market ?? null);
          setError(
            data.error ?? "Executable quote is below the minimum discount.",
          );
          setProgress("");
          setUi("review");
          await loadRest();
          scrollToReview();
          return;
        }
        setError(data.error ?? "Quote failed");
        setProgress("");
        setQuote(null);
        setQuoteBook(null);
        setUi("failed");
        await loadRest();
        scrollToReview();
        return;
      }
      setQuote(data.quote);
      setQuoteBook(data.market ?? null);
      setProgress("");
      setUi("review");
      await loadRest();
      scrollToReview();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not get an executable quote.";
      setError(message);
      setProgress("");
      setUi("failed");
    }
  }

  function scrollToReview() {
    document.getElementById("execution")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  async function closeReview() {
    setQuote(null);
    setQuoteBook(null);
    setProgress("");
    setError(null);
    setTxHash(null);
    setUi(decision?.action === "BUY" ? "buy" : "wait");
  }

  async function recordAbort(reason: string) {
    if (!record) return;
    await fetch("/api/execute/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionId: record.id, reason, walletAddress: address }),
    });
    await loadRest();
  }

  async function confirmPurchase() {
    setError(null);
    if (!quote) {
      setError("No executable quote. Click Review purchase first.");
      return;
    }
    if (!record || record.decision !== "BUY") {
      setError("No BUY decision is recorded for this review. Click Review purchase again.");
      return;
    }
    if (!address) {
      setError("Connect a wallet before confirming. No transaction was sent.");
      return;
    }
    if (chainId !== ROBINHOOD_CHAIN_ID) {
      setError(
        `Wallet is on chain ${chainId ?? "unknown"}. Robinhood Chain 4663 is required. No transaction was sent.`,
      );
      return;
    }
    if (!quoteMeetsMinDiscount(quote.discountPercent, settings?.minDiscountPercent ?? 0)) {
      setError(
        `Executable quote is ${quote.discountPercent}%, below your ${settings?.minDiscountPercent}% minimum. No transaction was sent.`,
      );
      return;
    }
    if (settings && quote.totalUsdg > settings.spendingLimitUsdg) {
      setError("Quoted cost exceeds Ora spending limit. No transaction was sent.");
      return;
    }
    if (balanceUsdg != null && balanceUsdg < quote.totalUsdg) {
      setError("Insufficient USDG in the connected wallet. No transaction was sent.");
      return;
    }
    if (nativeBalance != null && nativeBalance <= 0) {
      setError("Insufficient ETH for gas on Robinhood Chain 4663. No transaction was sent.");
      return;
    }

    const provider = window.ethereum;
    if (!provider) {
      setError("No injected wallet found. No transaction was sent.");
      return;
    }

    setConfirming(true);
    let submittedHash: `0x${string}` | null = null;
    try {
      setProgress("Validating purchase against the live book and quote");
      const validated = await fetch("/api/execute/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisionId: record.id, quote, walletAddress: address }),
      });
      const validatedJson = await validated.json();
      if (!validated.ok) {
        setError(validatedJson.error ?? "Validation failed");
        setQuote(validatedJson.quote ?? quote);
        setProgress("");
        setUi(
          validatedJson.code === "stale" ||
            validatedJson.code === "market_changed" ||
            validatedJson.code === "quote_below_threshold"
            ? "review"
            : "failed",
        );
        if (validatedJson.code === "market_changed") {
          setQuote(null);
          setQuoteBook(null);
        }
        await loadRest();
        if (validatedJson.code === "stale") scrollToReview();
        return;
      }
      const liveQuote = validatedJson.quote as ExecutableQuote;
      setQuote(liveQuote);

      setProgress("Checking USDG allowance for the exchange");
      const { createWalletClient, custom } = await import("viem");
      const signer = createWalletClient({
        chain: robinhoodChain,
        transport: custom(provider),
        account: address,
      });
      const liveChain = await signer.getChainId();
      if (liveChain !== ROBINHOOD_CHAIN_ID) {
        setError(
          `Wallet is on chain ${liveChain}. Robinhood Chain 4663 is required. No transaction was sent.`,
        );
        setProgress("");
        return;
      }

      const usdgIn = unitsToAtoms(liveQuote.totalUsdg);
      const client = publicClient();
      const allowance = (await client.readContract({
        address: CONTRACTS.usdg,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, CONTRACTS.exchange],
      })) as bigint;

      if (allowance < usdgIn) {
        setProgress(
          `Confirm USDG approval in your wallet (${liveQuote.totalUsdg} USDG to the exchange).`,
        );
        const approveHash = await signer.writeContract({
          account: address,
          chain: robinhoodChain,
          address: CONTRACTS.usdg,
          abi: erc20Abi,
          functionName: "approve",
          args: [CONTRACTS.exchange, usdgIn],
        });
        setProgress("Waiting for USDG approval to confirm onchain");
        const approveReceipt = await client.waitForTransactionReceipt({
          hash: approveHash,
          timeout: 180_000,
        });
        if (approveReceipt.status !== "success") {
          throw new Error("USDG approval transaction failed.");
        }
      }

      setProgress("Confirm buyAndActivate in your wallet");
      const hash = await signer.writeContract({
        account: address,
        chain: robinhoodChain,
        address: CONTRACTS.exchange,
        abi: exchangeAbi,
        functionName: "buyAndActivate",
        args: [
          usdgIn,
          (unitsToAtoms(liveQuote.creditOut) * 98n) / 100n,
          beneficiaryBytes32(address),
          BigInt(liveQuote.maxFills || 32),
        ],
      });
      submittedHash = hash;
      setTxHash(hash);
      setUi("pending");
      setProgress("Recording transaction as pending");

      const confirm = await fetch("/api/execute/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisionId: record.id,
          txHash: hash,
          walletAddress: address,
        }),
      });
      const confirmJson = await confirm.json();
      if (!confirm.ok) {
        setError(confirmJson.error ?? "Could not record the transaction.");
        setUi("pending");
        return;
      }

      setProgress("Waiting for purchase confirmation");
      try {
        await client.waitForTransactionReceipt({
          hash,
          timeout: 180_000,
        });
      } catch {
        // Server still verifies the receipt; do not claim success or failure yet.
      }

      let settled: Response | null = null;
      let settledJson: {
        error?: string;
        status?: string;
        record?: DecisionRecord;
      } = {};
      for (let attempt = 0; attempt < 20; attempt += 1) {
        settled = await fetch("/api/execute/receipt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decisionId: record.id,
            txHash: hash,
            creditAcquired: liveQuote.creditOut,
            totalUsdgPaid: liveQuote.totalUsdg,
            quotePrice: liveQuote.quotePrice,
            walletAddress: address,
          }),
        });
        settledJson = await settled.json();
        if (settled.status === 202 || settledJson.status === "pending") {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          continue;
        }
        break;
      }

      if (!settled || settled.status === 202 || settledJson.status === "pending") {
        setProgress("");
        setUi("pending");
        setError(
          "Transaction is submitted and pending confirmation. Ora will not treat it as successful until it confirms onchain.",
        );
        await loadRest();
        return;
      }
      if (!settled.ok) {
        setError(settledJson.error ?? "Transaction failed");
        setUi("failed");
        await loadRest();
        return;
      }
      setProgress("");
      setError(null);
      setQuote(null);
      setQuoteBook(null);
      if (settledJson.record) setRecord(settledJson.record);
      setUi("success");
      await loadRest();
      await refreshBalance();
    } catch (err) {
      const message = classifyTxError(err);
      setError(message);
      setProgress("");
      if (submittedHash) {
        setTxHash(submittedHash);
        setUi("pending");
        await loadRest();
      } else {
        setUi("failed");
        await recordAbort(message);
      }
    } finally {
      setConfirming(false);
    }
  }

  const wrongNetwork = isConnected && chainId !== ROBINHOOD_CHAIN_ID;
  const bookDiscount =
    quoteBook?.bestDiscount ??
    record?.market.discountPercent ??
    market?.bestDiscount;
  const quoteMeetsRule =
    Boolean(quote) &&
    settings != null &&
    quoteMeetsMinDiscount(quote!.discountPercent, settings.minDiscountPercent);
  const insufficientUsdg =
    isConnected &&
    quote != null &&
    balanceUsdg != null &&
    balanceUsdg < quote.totalUsdg;
  const insufficientGas =
    isConnected && nativeBalance != null && nativeBalance <= 0;
  const confirmBlocked =
    confirming ||
    !isConnected ||
    !record ||
    record.decision !== "BUY" ||
    wrongNetwork ||
    ui === "pending" ||
    !quoteMeetsRule ||
    insufficientUsdg ||
    insufficientGas;
  const bookVsQuote =
    quote != null &&
    bookDiscount != null &&
    Math.abs(bookDiscount - quote.discountPercent) > 0.05;
  const maxDepth = Math.max(
    ...(market?.depth.map((d) => d.availableCredit) ?? [1]),
    1,
  );
  const recent = history.slice(0, 8);
  const minDiscount =
    settings?.minDiscountPercent ?? decision?.params.minDiscountPercent;
  const checkMinimumDiscount =
    decision?.params.minDiscountPercent ?? settings?.minDiscountPercent ?? null;
  const checkExecutableDiscount =
    quote?.discountPercent ??
    decision?.executable?.discountPercent ??
    record?.executable?.discountPercent ??
    null;
  const checkCreditRequested =
    decision?.requestedAmount ??
    decision?.params.requestedCredit ??
    quote?.requestedCredit ??
    settings?.requestedCredit ??
    null;
  const checkExecutableQuote =
    quote?.totalUsdg ??
    decision?.executable?.totalUsdg ??
    record?.executable?.totalUsdg ??
    null;
  const checkSpendingLimit =
    decision?.params.spendingLimitUsdg ??
    record?.evaluatedSpendingLimitUsdg ??
    settings?.spendingLimitUsdg ??
    null;
  const showDecide = !decision && !executablePending;
  const decisionWhy = decision?.reason ?? null;
  const meetsThreshold =
    minDiscount != null && market != null && market.bestDiscount >= minDiscount;

  return (
    <main className="desk">
      <section className="command-center" id="market">
        {ui === "market_loading" && !market && (
          <p className="status is-loading">Loading CREDIT book…</p>
        )}
        {refreshing && market && (
          <p className="status is-loading">Refreshing CREDIT book…</p>
        )}
        {marketError && (
          <p className="error">{marketError}</p>
        )}
        {market && (
          <div className="command-grid">
            <div className="command-lead">
              <div className="command-decision" id="decision">
                <p className="command-kicker">
                  {isBookPreview ? "Book preview" : "Ora Decision"}
                </p>
                {!decision &&
                  (ui === "decision_loading" || executablePending) &&
                  ui !== "failed" && (
                    <p className="status">Evaluating…</p>
                  )}
                {!decision && ui === "failed" && error && (
                  <p className="error">{error}</p>
                )}
                {!decision &&
                  !executablePending &&
                  ui !== "decision_loading" &&
                  ui !== "failed" && (
                    <p className="status">Waiting for market data.</p>
                  )}
                {decision && (
                  <>
                    <p
                      key={decision.action}
                      className={`decision-mark ${decision.action === "BUY" ? "buy" : "wait"}`}
                    >
                      {decision.action}
                    </p>
                    {decisionWhy && (
                      <p className="decision-why">{decisionWhy}</p>
                    )}
                    {((reasoningMatchesDecision && !isBookPreview) ||
                      (ui === "decision_loading" && !evaluationMatches)) && (
                      <div className="orbio-reasoning">
                        <p className="command-kicker orbio-reasoning-heading">
                          <span>Orbio reasoning</span>
                          {evaluationMatches && reasoning && (
                            <>
                              <span
                                className="orbio-reasoning-chevron"
                                aria-hidden="true"
                              >
                                ›
                              </span>
                              <span
                                className={`orbio-reasoning-action ${reasoning.recommendation === "BUY" ? "buy" : "wait"}`}
                              >
                                {reasoning.recommendation}
                              </span>
                            </>
                          )}
                        </p>
                        {ui === "decision_loading" && !evaluationMatches && (
                          <p className="status">Requesting interpretation…</p>
                        )}
                        {evaluationMatches && reasoningUnavailable && (
                          <>
                            <p className="orbio-reasoning-unavailable">
                              Not available
                            </p>
                            <p className="orbio-reasoning-copy">
                              Ora&apos;s deterministic decision remains valid.
                            </p>
                          </>
                        )}
                        {evaluationMatches && reasoning && (
                          <>
                            {!reasoning.agreesWithRule && (
                              <p className="orbio-reasoning-disagree">
                                Disagrees with Ora&apos;s {decision.action}{" "}
                                rule. Does not override the decision.
                              </p>
                            )}
                            {reasoning.agreesWithRule && (
                              <p className="orbio-reasoning-agree">
                                Agrees with Ora&apos;s deterministic rule.
                              </p>
                            )}
                            <p className="orbio-reasoning-copy">
                              {reasoning.rationale}
                            </p>
                            {reasoning.risks.length > 0 && (
                              <aside className="orbio-considerations">
                                <p className="orbio-considerations-label">
                                  Considerations
                                </p>
                                <ul>
                                  {reasoning.risks.map((risk) => (
                                    <li key={risk}>{risk}</li>
                                  ))}
                                </ul>
                              </aside>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="command-discount">
                <p className="command-kicker">
                  <span className="live-dot" aria-hidden="true" />
                  Best available discount
                </p>
                <p
                  key={market.bestDiscount}
                  className="command-discount-value mono"
                >
                  {market.bestDiscount}%
                </p>
                {minDiscount != null && decision?.action !== "BUY" && (
                  <p
                    className={`command-threshold ${meetsThreshold ? "meets" : "below"}`}
                  >
                    {meetsThreshold ? "Meets threshold" : "Below threshold"}
                  </p>
                )}
                {decision && (
                  <p
                    className={`command-readiness ${decision.action === "BUY" ? "buy" : "wait"}`}
                  >
                    {isBookPreview
                      ? address
                        ? "Order-book preview. Not a recorded decision."
                        : "Order-book preview. Connect a wallet for Ora's quote-checked decision."
                      : decision.action === "BUY"
                        ? "Ora is ready to buy."
                        : "Ora is waiting."}
                  </p>
                )}
                <div className="procurement-check">
                  <p className="command-kicker">Procurement check</p>
                  <div className="procurement-rows">
                    <ProcurementRow
                      label="Minimum discount"
                      value={formatCheckPercent(checkMinimumDiscount)}
                    />
                    <ProcurementRow
                      label="Executable discount"
                      value={formatCheckPercent(checkExecutableDiscount)}
                    />
                    <ProcurementRow
                      label="CREDIT requested"
                      value={formatCheckCredit(checkCreditRequested)}
                    />
                    <ProcurementRow
                      label="Executable quote"
                      value={formatCheckUsdg(checkExecutableQuote)}
                    />
                    <ProcurementRow
                      label="Spending limit"
                      value={formatCheckUsdg(checkSpendingLimit)}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="command-action-row">
              <div className="command-explain">
                {decision?.action === "BUY" && (
                  <p className="decision-amount mono">
                    {formatCredit(decision.requestedAmount ?? 0)} CREDIT
                    <span className="decision-sublabel"> requested</span>
                  </p>
                )}
                {decision?.action === "WAIT" && (
                  <p className="status">
                    No purchase is offered while Ora waits.
                  </p>
                )}
              </div>
              <div className="command-actions">
                {showDecide && (
                  <button
                    className="btn btn-action command-cta"
                    type="button"
                    disabled={ui === "decision_loading"}
                    onClick={() => {
                      if (settings) void ensureRecorded(settings);
                    }}
                  >
                    {ui === "decision_loading" ? "Deciding…" : "Decide"}
                  </button>
                )}
                {decision?.action === "BUY" && (
                  <button
                    className="btn btn-action command-cta command-review"
                    type="button"
                    disabled={Boolean(progress) && ui !== "review"}
                    onClick={() => void requestQuote()}
                  >
                    {progress && !quote ? "Getting quote…" : "Review purchase"}
                  </button>
                )}
                <button
                  className="btn secondary command-ghost"
                  type="button"
                  disabled={refreshing}
                  onClick={() => void loadMarket()}
                >
                  {refreshing ? "Refreshing…" : "Refresh book"}
                </button>
              </div>
            </div>

            <div className="command-metrics">
              <div className="command-stat">
                <span className="command-kicker">CREDIT price</span>
                <span className="command-stat-value mono">
                  {formatPrice(market.creditPrice)} USDG
                </span>
              </div>
              <div className="command-stat">
                <span className="command-kicker">Available</span>
                <span className="command-stat-value mono">
                  {formatCredit(market.totalAvailableCredit)} CREDIT
                </span>
              </div>
              <div className="command-stat">
                <span className="command-kicker">Available at best discount</span>
                <span className="command-stat-value mono">
                  {formatCredit(market.availableAtBestDiscount)}
                </span>
              </div>
              <div className="command-stat">
                <span className="command-kicker">Last updated</span>
                <span className="command-stat-value mono">
                  {formatTime(market.timestamp, true)}
                </span>
              </div>
            </div>

            {market.depth.length > 0 && (
              <div className="depth command-depth" aria-label="Market depth">
                {market.depth.map((level, index) => {
                  const qualifies =
                    minDiscount != null &&
                    level.discountPercent >= minDiscount;
                  return (
                    <div
                      className={`depth-row${qualifies ? " is-qualifying" : " is-below"}`}
                      key={level.discountPercent}
                      style={{ animationDelay: `${index * 40}ms` }}
                    >
                      <span className="depth-label">
                        <span className="depth-percent">
                          {level.discountPercent}%
                        </span>
                      </span>
                      <div className="bar">
                        <span
                          style={{
                            width: `${Math.max(
                              (level.availableCredit / maxDepth) * 100,
                              level.availableCredit > 0 ? 2 : 0,
                            )}%`,
                          }}
                        />
                      </div>
                      <span className="depth-credit">
                        {formatCredit(level.availableCredit)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="panel settings-panel" id="settings">
        <h2>Procurement settings</h2>
        {!isConnected && (
          <p className="status">
            Wallet disconnected. Connect from the top bar before confirming a purchase.
          </p>
        )}
        {isConnected && (
          <p className="status">
            USDG: {balanceUsdg == null ? "…" : formatPrice(balanceUsdg)}
            {" · "}
            ETH: {nativeBalance == null ? "…" : formatPrice(nativeBalance)}
            {wrongNetwork
              ? " · Robinhood Chain 4663 required before sending."
              : " · Robinhood Chain 4663"}
          </p>
        )}
        {settings && (
          <form
            className="settings-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveParameters(settings);
            }}
          >
            <fieldset className="settings-group">
              <legend>Purchase parameters</legend>
              <div className="fields">
                <label>
                  CREDIT to procure
                  <input
                    type="number"
                    min={market?.minBuyCredit ?? 5}
                    step="1"
                    value={settings.requestedCredit}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        requestedCredit: Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label>
                  Spending limit (USDG)
                  <input
                    type="number"
                    min={5}
                    step="1"
                    value={settings.spendingLimitUsdg}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        spendingLimitUsdg: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="settings-group">
              <legend>Decision rule</legend>
              <div className="fields">
                <label>
                  Minimum discount (%)
                  <input
                    type="number"
                    min={0}
                    step="1"
                    value={settings.minDiscountPercent}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        minDiscountPercent: Number(e.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </fieldset>
            <button
              className="btn secondary"
              type="submit"
              disabled={saveStatus === "saving"}
            >
              {saveStatus === "saving"
                ? "Saving…"
                : saveStatus === "saved"
                  ? "Saved ✓"
                  : "Save parameters"}
            </button>
            {saveError && (
              <p className="error settings-save-error">{saveError}</p>
            )}
          </form>
        )}
        <p className="status settings-note">
          Ora uses these parameters for its procurement decision. Save changes
          before reviewing a purchase.
        </p>
        {market && (
          <p className="status settings-constraint">
            Minimum CREDIT size supported by the live book:{" "}
            {formatCredit(market.minBuyCredit)}.
          </p>
        )}
      </section>

      {(quote || progress || ui === "review" || ui === "pending" || ui === "success" || ui === "failed" || error) && (
        <section
          className={`panel panel-execution${ui === "success" ? " is-success" : ""}${ui === "failed" ? " is-failed" : ""}${ui === "pending" ? " is-pending" : ""}`}
          id="execution"
        >
          <h2>Purchase review</h2>
          {error && <p className="error">{error}</p>}
          {progress && <p className="status is-loading">{progress}</p>}
          {ui === "pending" && (
            <p className="status">Transaction pending confirmation.</p>
          )}
          {quote && (
            <>
              <div className="review-block review-primary">
                <h3>Market decision</h3>
                <p
                  className={`decision-mark review-mark ${
                    decision?.action === "WAIT" ? "wait" : "buy"
                  }`}
                >
                  {decision?.action ?? "BUY"}
                </p>
                <p className="review-lead">
                  {decisionWhy ??
                    decision?.reason ??
                    "Ora recommended BUY from the CREDIT book. The executable quote is fetched separately and may differ."}
                </p>
                <div className="row">
                  <span className="label">Best available discount (book)</span>
                  <span className="value">{bookDiscount ?? "—"}%</span>
                </div>
                <div className="row">
                  <span className="label">Your minimum discount</span>
                  <span className="value">{settings?.minDiscountPercent}%</span>
                </div>
              </div>
              <div className="review-block">
                <h3>Requested purchase</h3>
                <p className="decision-amount mono">
                  {formatCredit(quote.requestedCredit)} CREDIT
                  <span className="decision-sublabel"> requested</span>
                </p>
                <div className="row">
                  <span className="label">Quoted USDG</span>
                  <span className="value">{quote.totalUsdg} USDG</span>
                </div>
                <div className="row">
                  <span className="label">Available at book discount</span>
                  <span className="value">
                    {formatCredit(
                      quoteBook?.availableAtBestDiscount ??
                        record?.market.availableDepth ??
                        market?.availableAtBestDiscount ??
                        0,
                    )}{" "}
                    CREDIT
                  </span>
                </div>
              </div>
              <div className="review-block">
                <h3>Execution quote</h3>
                {bookVsQuote && (
                  <p className="error">
                    Book {bookDiscount}% is not the fill price. This quote buys
                    CREDIT at {quote.quotePrice} USDG ({quote.discountPercent}%
                    executable discount).
                  </p>
                )}
                {!bookVsQuote && (
                  <p className="status">
                    Book price/discount is not necessarily the actual fill
                    price. Confirm against this executable quote.
                  </p>
                )}
                <div className="row">
                  <span className="label">Effective price</span>
                  <span className="value">{quote.quotePrice} USDG / CREDIT</span>
                </div>
                <div className="row">
                  <span className="label">Executable discount</span>
                  <span className="value">{quote.discountPercent}%</span>
                </div>
              </div>
              <div className="review-block">
                <h3>Wallet / execution readiness</h3>
                <div className="row">
                  <span className="label">Status</span>
                  <span className="value">
                    {isConnected ? "Connected" : "Disconnected"}
                  </span>
                </div>
                <div className="row">
                  <span className="label">Network</span>
                  <span className="value">
                    {wrongNetwork
                      ? `Wrong network (${chainId}). Robinhood Chain 4663 required.`
                      : isConnected
                        ? "Robinhood Chain 4663"
                        : "Robinhood Chain 4663 required"}
                  </span>
                </div>
                <div className="row">
                  <span className="label">USDG</span>
                  <span className="value">
                    {isConnected
                      ? balanceUsdg == null
                        ? "…"
                        : formatPrice(balanceUsdg)
                      : "Unknown until connected"}
                  </span>
                </div>
                <div className="row">
                  <span className="label">ETH (gas)</span>
                  <span className="value">
                    {isConnected
                      ? nativeBalance == null
                        ? "…"
                        : formatPrice(nativeBalance)
                      : "Unknown until connected"}
                  </span>
                </div>
                {!isConnected && (
                  <p className="status">
                    Connect a wallet from the top bar. Review can fetch a quote,
                    but no purchase is sent until you confirm in the wallet.
                  </p>
                )}
                {wrongNetwork && (
                  <p className="error">
                    Switch to Robinhood Chain 4663 before confirming. Use Switch
                    in the top bar.
                  </p>
                )}
                {quote && !quoteMeetsRule && (
                  <p className="error">
                    Confirm purchase is unavailable because the executable quote
                    does not meet your {settings?.minDiscountPercent}% minimum.
                  </p>
                )}
                {insufficientUsdg && (
                  <p className="error">
                    Insufficient USDG for this quote. Confirm stays disabled.
                  </p>
                )}
                {insufficientGas && (
                  <p className="error">
                    Insufficient ETH for gas on Robinhood Chain 4663. Confirm
                    stays disabled.
                  </p>
                )}
              </div>
              {ui !== "success" && (
                <div className="command-actions review-actions">
                  <button
                    className="btn btn-action"
                    type="button"
                    disabled={confirmBlocked}
                    onClick={() => {
                      confirmPurchase().catch((err) => {
                        setError(classifyTxError(err));
                        setProgress("");
                        setUi("failed");
                        setConfirming(false);
                      });
                    }}
                  >
                    {confirming ? progress || "Working…" : "Confirm purchase"}
                  </button>
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => closeReview()}
                  >
                    Close review
                  </button>
                </div>
              )}
              <details className="review-tech">
                <summary>Technical details</summary>
                <div className="row">
                  <span className="label">Quoted at</span>
                  <span className="value">{formatTime(quote.quotedAt)}</span>
                </div>
                <div className="row">
                  <span className="label">Spending limit</span>
                  <span className="value">{settings?.spendingLimitUsdg} USDG</span>
                </div>
                <div className="row">
                  <span className="label">Exchange</span>
                  <span className="value">{CONTRACTS.exchange}</span>
                </div>
                <div className="row">
                  <span className="label">Payment</span>
                  <span className="value">USDG approve, then buyAndActivate</span>
                </div>
                <div className="row">
                  <span className="label">Address</span>
                  <span className="value">
                    {address ?? "Connect a wallet to confirm."}
                  </span>
                </div>
                <div className="row">
                  <span className="label">CREDIT out (quote)</span>
                  <span className="value">{quote.creditOut}</span>
                </div>
                <div className="row">
                  <span className="label">Max fills</span>
                  <span className="value">{quote.maxFills}</span>
                </div>
              </details>
            </>
          )}
          {ui === "success" && (
            <>
              <p className="success-copy">Purchase confirmed onchain.</p>
              <div className="row">
                <span className="label">Acquired CREDIT</span>
                <span className="value">{record?.creditAcquired}</span>
              </div>
              <div className="row">
                <span className="label">Execution price</span>
                <span className="value">{record?.executionPrice ?? record?.quotePrice}</span>
              </div>
              <div className="row">
                <span className="label">Transaction</span>
                <span className="value">{txHash}</span>
              </div>
            </>
          )}
        </section>
      )}

      <section className="panel history-panel" id="recent">
        <h2>Recent decisions</h2>
        {recent.length === 0 && (
          <p className="status">No decisions recorded yet.</p>
        )}
        {recent.length > 0 && (
          <div className="table-wrap">
          <table className="history">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Discount</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((item) => (
                <tr
                  key={item.id}
                  className="history-row"
                  tabIndex={0}
                  onClick={() => setSelected(item)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setSelected(item);
                    }
                  }}
                >
                  <td>{formatTime(item.timestamp)}</td>
                  <td className={item.decision === "BUY" ? "action-buy" : "action-wait"}>
                    {item.decision}
                  </td>
                  <td>{item.market.discountPercent}%</td>
                  <td>{item.requestedAmount ?? "—"}</td>
                  <td>
                    <span
                      className={recordStageClass(
                        item.executionStatus,
                        item.decision,
                      )}
                    >
                      {recordStage(item.executionStatus, item.decision)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {selected && (
          <div className="detail">
            <h3>Decision record</h3>
            <div className="row">
              <span className="label">Time</span>
              <span className="value">{formatTime(selected.timestamp)}</span>
            </div>
            <div className="row">
              <span className="label">Action</span>
              <span className="value">{selected.decision}</span>
            </div>
            <div className="row">
              <span className="label">Discount</span>
              <span className="value">{selected.market.discountPercent}%</span>
            </div>
            <div className="row">
              <span className="label">Reason</span>
              <span className="value">{selected.reason}</span>
            </div>
            <div className="row">
              <span className="label">Status</span>
              <span className="value">
                <span
                  className={recordStageClass(
                    selected.executionStatus,
                    selected.decision,
                  )}
                >
                  {recordStage(selected.executionStatus, selected.decision)}
                </span>
              </span>
            </div>
            <div className="row">
              <span className="label">Execution</span>
              <span className="value">
                {executionLabel(selected.executionStatus, selected.decision)}
              </span>
            </div>
            {selected.quotedUsdg != null && (
              <div className="row">
                <span className="label">Quoted USDG</span>
                <span className="value">{selected.quotedUsdg}</span>
              </div>
            )}
            {selected.blockedReason && (
              <div className="row">
                <span className="label">Note</span>
                <span className="value">{selected.blockedReason}</span>
              </div>
            )}
            {selected.confirmedAt && (
              <div className="row">
                <span className="label">Confirmed</span>
                <span className="value">{formatTime(selected.confirmedAt)}</span>
              </div>
            )}
            {selected.txHash && (
              <div className="row">
                <span className="label">Transaction</span>
                <span className="value">{selected.txHash}</span>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

function formatCheckPercent(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value}%`;
}

function formatCheckCredit(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return formatCredit(value);
}

function formatCheckUsdg(value: number | null): string {
  if (value == null || Number.isNaN(value)) return "—";
  return `${value.toLocaleString("en-US", {
    maximumFractionDigits: 6,
    minimumFractionDigits: 0,
  })} USDG`;
}

function ProcurementRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="procurement-row">
      <span className="procurement-label">{label}</span>
      <span className="procurement-leader" aria-hidden="true" />
      <span className="procurement-value mono">{value}</span>
    </div>
  );
}
