# Ora

Ora is a procurement agent for Orbio CREDIT. It watches the CREDIT market and decides whether to BUY or WAIT based on procurement parameters set by the user.

## What is Ora?

Orbio makes inference tradable through CREDIT. Ora treats that CREDIT as a procurement decision: the user sets parameters, and Ora checks the live market against them. The decision is BUY or WAIT.

## How It Works

1. Connect a wallet.
2. Set procurement parameters:
   - CREDIT to procure
   - Spending limit (USDG)
   - Minimum acceptable discount
3. Ora reads the live CREDIT market.
4. Ora evaluates the market with its deterministic decision rules.
5. If conditions are met, Ora returns BUY.
6. If conditions are not met, Ora returns WAIT.
7. For a BUY decision, Ora retrieves a fresh executable quote before anything is signed.
8. The user reviews the quote and approves the transaction in their wallet.
9. The purchase is executed through Orbio's CREDIT exchange contract.
10. The transaction is verified after confirmation.
11. Decisions and execution outcomes are recorded in History.
12. Performance can later compare completed purchases against the relevant market baseline.

Ora does not sign transactions or move funds by itself. A purchase proceeds only after the user approves it in their wallet.

Initial parameter defaults are 5 CREDIT, a 25 USDG spending limit, and a 20% minimum discount. Saved settings are stored per wallet.

## Decision Logic

The requested amount is floored to the live market's minimum buy size:

```
requested = max(requestedCredit, market.minBuyCredit)
```

Ora then checks order-book levels against the configured minimum discount. A level qualifies when its discount is at least that minimum and it has enough available CREDIT for `requested`.

BUY is returned when a qualifying level can fill the request. Otherwise Ora returns WAIT.

The deterministic rule is authoritative.

## Orbio Reasoning

Orbio reasoning uses `ORBIO_API_KEY` on the server. It receives the market snapshot and the decision context (price, depth, requested CREDIT, minimum discount, spending limit, and the deterministic BUY or WAIT) and returns a short explanation.

The rule makes the decision. Orbio provides a short explanation for why that decision makes sense.

Reasoning is advisory. It cannot change the BUY/WAIT result, the spending limit, the quote, the wallet, or transaction execution. If the reasoning call fails or `ORBIO_API_KEY` is missing, Ora still records the deterministic decision.

## Purchase Safety

- A fresh executable quote is fetched from the exchange before a purchase is offered.
- The quote is checked against the user's spending limit and minimum discount. A quote that misses either check is not offered for purchase.
- A quote older than 90 seconds is rejected.
- Before signing, Ora re-reads the book, runs the BUY rule again, and fetches a new quote. A market that is no longer BUY, a moved price, missing liquidity, or a spending-limit breach stops the purchase.
- The connected wallet must be on Robinhood Chain. The user approves any required USDG allowance and the `buyAndActivate` call.
- Ora records a successful purchase only after the onchain receipt status is success.
- A submitted transaction that has not confirmed stays pending. A reverted transaction, or one that is not a purchase on the exchange, is recorded as failed.

## History

History is a read-only audit log of procurement decisions and their execution lifecycle. BUY and WAIT decisions are both recorded, for the connected wallet.

Statuses shown in History:

- **Decision**: a BUY or WAIT decision was recorded.
- **Review**: BUY is waiting on quote review.
- **Pending**: a transaction was submitted and is awaiting confirmation.
- **Confirmed**: the transaction confirmed onchain.
- **Failed**: execution did not complete.

## Performance

Performance measures completed procurement outcomes from recorded activity and a later market snapshot.

It can evaluate:

- BUY and WAIT activity
- Confirmed purchases
- CREDIT purchased
- Total cost
- Average effective price
- Comparable buy-on-demand cost
- Difference between Ora's purchase and the relevant baseline

The baseline is the cost of buying the same CREDIT size later at the later book's listed CREDIT price. Confirmed fills are included in the cost totals. Reviewed, pending, and failed BUY rows stay unresolved until a purchase confirms. A confirmed purchase stays unresolved until a later market snapshot exists.

Performance does not claim profitability. It reports outcomes from the ledger and later market data.

## Architecture

- `app/`: Next.js App Router pages and API routes (market desk, history, performance, decision, quote, and execution).
- `components/`: UI components.
- `lib/orbio/`: Orbio market book, exchange quotes, contracts, and reasoning client.
- `lib/ora/`: procurement parameters, the BUY/WAIT rule, quote checks, outcomes, and performance.
- `lib/db/`: Supabase persistence for decisions and settings.
- `lib/wallet/`: injected-wallet connection on Robinhood Chain.
- `types/`: shared types.

`ORBIO_API_KEY` and `SUPABASE_SECRET_KEY` are read on the server. They are not exposed to the browser.

## Orbio Integration

- CREDIT order book from `ORBIO_MARKET_ORIGIN` at `/api/market/book` (default `https://www.orbio.so`).
- Executable quotes from `getQuoteForCredit` on the CREDIT exchange.
- CREDIT purchase and activation through `buyAndActivate`, paid in USDG.
- Orbio reasoning through `https://api.orbio.so/api/v1`.
- Robinhood Chain.
- Chain ID: `4663`.
- CREDIT exchange contract: `0x6951ffd32630b05e06f50062aea801625a58ebc0`.

CREDIT represents inference usage. In this integration, 1 CREDIT corresponds to $1 of usage. The book price is that face value minus the listed discount, quoted in USDG.

## Environment Variables

Copy `.env.example` to `.env.local` for local runs. Keep secret values out of the client and out of git.

| Variable | Role |
| --- | --- |
| `ORBIO_API_KEY` | Server-side key for Orbio reasoning. If it is unset, reasoning is skipped and the deterministic decision still runs. |
| `SUPABASE_URL` | Supabase project URL. Required to store decisions and settings. |
| `SUPABASE_SECRET_KEY` | Server-side Supabase key. Required with `SUPABASE_URL`. |
| `ROBINHOOD_RPC_URL` | Robinhood Chain RPC. Defaults to `https://rpc.mainnet.chain.robinhood.com`. |
| `ORBIO_MARKET_ORIGIN` | Origin for the CREDIT order book. Defaults to `https://www.orbio.so`. |
| `ORBIO_REASONING_MODEL` | Reasoning model id. Defaults to `google/gemini-3.8-flash` when unset. |

## Local Development

This repo uses npm (`package-lock.json`).

```bash
npm install
```

Copy `.env.example` to `.env.local` and fill in the variables above.

```bash
npm run dev
```

Production build (Next.js also typechecks during this build):

```bash
npm run build
```

There is no separate typecheck script.

## Deployment

Ora is a Next.js application deployed on Vercel. Set the environment variables in the Vercel project so credentials stay on the server.

## Current Scope

Ora currently does the following:

- Live CREDIT market observation
- Deterministic BUY/WAIT procurement decisions
- Configurable procurement parameters
- Orbio reasoning
- Quote review and validation
- User-approved CREDIT purchase
- Execution confirmation
- Decision history
- Performance measurement

That scope is CREDIT procurement on this desk: watch the book, decide BUY or WAIT, and complete a purchase only with the user's wallet.

## Roadmap

Not built yet.

One of the directions I want to explore next is prediction markets around CREDIT, giving builders and agents a way to bet on where the price of CREDIT will be in the next hour. We could start with one-hour markets.
