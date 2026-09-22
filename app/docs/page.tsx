import type { Metadata } from "next";
import { DocsToc } from "../../components/DocsToc";

export const metadata: Metadata = {
  title: "Docs — Ora",
  description:
    "How Ora observes the CREDIT market, decides BUY or WAIT, reviews executable quotes, and records outcomes.",
};

export default function DocsPage() {
  return (
    <div className="landing-page">
      <main className="landing docs-page">
        <header className="landing-nav">
          <a className="wordmark" href="/">
            Ora
          </a>
          <nav className="landing-links" aria-label="Landing">
            <a href="/docs" aria-current="page">
              Docs
            </a>
          </nav>
        </header>

        <header className="docs-hero">
          <p className="docs-kicker">Documentation</p>
          <h1>How Ora works</h1>
          <p className="docs-lede">
            Ora is a procurement agent for Orbio CREDIT. It watches the live
            CREDIT market and helps determine when to acquire inference at a
            better available price.
          </p>
          <p className="docs-lede">
            In short: Ora makes CREDIT procurement more deliberate by combining
            live market conditions, your procurement rules, and executable
            purchase checks.
          </p>
        </header>

        <div className="docs-layout">
          <div className="docs-main">
            <article className="docs-article">
              <section id="what-is-ora">
                <h2>What is Ora?</h2>
                <p>Ora is an agent for procurement of Orbio CREDIT.</p>
                <p>
                  Ora operates through a procurement desk. CREDIT is treated as
                  a tradable unit of inference capacity on Orbio. Ora does not
                  invent market data; it reads the live Orbio order book.
                </p>
                <p>
                  The product surface is a Market desk for the live decision, a
                  Purchase review before any transaction, History for recorded
                  decisions, and Performance for confirmed outcomes.
                </p>
              </section>

              <section id="how-ora-decides">
                <h2>How Ora decides BUY or WAIT</h2>
                <ol className="process-flow" aria-label="How Ora decides">
                  <li>Live Orbio book</li>
                  <li>Minimum discount</li>
                  <li>Can requested CREDIT be fulfilled?</li>
                  <li>BUY / WAIT</li>
                </ol>
                <p>
                  You set three procurement parameters: CREDIT to procure, a USDG
                  spending limit, and a minimum discount. The requested purchase
                  size is the CREDIT to procure amount, floored to the live book
                  minimum purchase size when that book minimum is higher.
                </p>
                <p>
                  Ora then inspects the live depth. A level qualifies when its
                  discount is at least your minimum discount. BUY is offered only
                  if a qualifying level has enough CREDIT to fulfill the requested
                  amount. Otherwise Ora waits.
                </p>
                <p>
                  If the best qualifying level cannot fill the request, Ora does
                  not treat that as BUY. Review purchase appears only when the
                  current decision is BUY.
                </p>
              </section>

              <section id="market-data">
                <h2>Market data and order-book depth</h2>
                <p>
                  Market snapshots come from Orbio’s CREDIT book. Ora normalizes
                  each depth level to a discount percent and available CREDIT,
                  ordered from the deepest discount downward. The desk shows CREDIT
                  price, best available discount, total available CREDIT, and
                  CREDIT available at the best discount.
                </p>
                <p>
                  The book also reports a minimum CREDIT purchase size. Ora keeps
                  that constraint: requested size cannot go below it. Depth on the
                  desk highlights the level that matches your current minimum
                  discount when that level exists on the book. Listed book discount
                  is not automatically the fill price of a later quote.
                </p>
              </section>

              <section id="purchase-review">
                <h2>Purchase review and executable quotes</h2>
                <p>
                  Review purchase fetches a fresh executable quote for the
                  requested CREDIT amount. The review keeps market decision and
                  execution quote separate: the book may show one discount, while
                  the quote states the price and discount at which CREDIT would
                  actually be bought.
                </p>
                <p>
                  If the quoted discount is below your minimum, or the quoted USDG
                  cost exceeds the spending limit, or the quote cannot fill, Ora
                  does not offer a purchase. Confirm stays subject to those checks.
                </p>
              </section>

              <section id="execution">
                <h2>Execution and wallet confirmation</h2>
                <ol className="process-flow" aria-label="Purchase execution">
                  <li>Market decision</li>
                  <li>Fresh quote</li>
                  <li>Validate</li>
                  <li>User confirms</li>
                  <li>Buy + activate</li>
                </ol>
                <p>
                  A purchase is sent only after you confirm. The connected wallet
                  must be on Robinhood Chain 4663. Payment is USDG: Ora checks
                  allowance, requests approval if needed, then calls buyAndActivate
                  on the exchange.
                </p>
                <p>
                  Confirm purchase stays disabled when a wallet is disconnected,
                  the network is wrong, the quote fails the minimum discount, USDG
                  is insufficient, ETH for gas is insufficient, or a transaction is
                  already pending. A BUY decision is not a completed purchase until
                  the transaction confirms onchain.
                </p>
              </section>

              <section id="decision-history">
                <h2>Decision history</h2>
                <p>
                  Each recorded decision is stored in a local ledger with time,
                  BUY or WAIT, discount at decision, requested amount, and status.
                  Status is Decision, Review, Pending, Confirmed, or Failed. History
                  and Recent decisions use that ledger. Selecting a row shows the
                  stored reason and any quote, block, or transaction details.
                </p>
              </section>

              <section id="performance">
                <h2>Performance and outcome evaluation</h2>
                <p>
                  Performance counts BUY and WAIT decisions, but only confirmed
                  onchain purchases enter procurement totals. Reviewed, pending,
                  rejected, or failed BUY rows are unresolved; they are not treated
                  as savings or as successful fills.
                </p>
                <p>
                  When a confirmed fill exists and a later market snapshot is
                  available, Ora can compare USDG paid against buying the same
                  CREDIT size later at the later book’s listed CREDIT price. That
                  comparison is a log, not proof of a winning strategy. WAIT
                  outcomes describe how the later listed discount moved; they do
                  not claim that waiting is a strategy.
                </p>
              </section>

              <section id="limitations">
                <h2>Limitations and assumptions</h2>
                <p>
                  CREDIT markets can be thin. A qualifying discount with too little
                  CREDIT at that level produces WAIT. A BUY reflects the current
                  book and your procurement rules. It does not guarantee a better
                  fill than waiting.
                </p>
                <p>
                  The executable quote can differ from the book. Outcomes versus a
                  later buy-on-demand price stay unresolved until a later market
                  snapshot exists. Ora presents early results as a log, not a
                  strategy score, and does not count unconfirmed BUY decisions as
                  purchases.
                </p>
              </section>
            </article>

            <p className="docs-end">
              <a className="btn cta" href="/app">
                Open Ora
              </a>
            </p>
          </div>

          <DocsToc />
        </div>
      </main>
    </div>
  );
}
