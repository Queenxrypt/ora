import { OraMark } from "../components/OraMark";
import { readMarketSnapshot } from "../lib/orbio/market";
import { formatCredit, formatPrice } from "../lib/ora/format";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export default async function LandingPage() {
  let market: Awaited<ReturnType<typeof readMarketSnapshot>> | null = null;
  let marketError: string | null = null;
  try {
    market = await readMarketSnapshot();
  } catch (error) {
    marketError =
      error instanceof Error ? error.message : "Market data unavailable";
  }

  return (
    <div className="landing-page">
      <main className="landing">
        <header className="landing-nav">
          <a className="wordmark" href="/">
            Ora
          </a>
          <nav className="landing-links" aria-label="Landing">
            <a href="/docs">Docs</a>
          </nav>
        </header>

        <section className="hero-row">
          <div className="hero">
            <h1>
              <OraMark className="hero-logo" />
            </h1>
            <p className="tagline">Smarter procurement for Orbio CREDIT.</p>
            <p className="lede">
              An agent that watches the CREDIT market, decides when inference is
              worth acquiring, and records whether that decision was actually
              useful.
            </p>
            <p>
              <a className="btn cta" href="/app">
                Open Ora
              </a>
            </p>
          </div>

          <aside className="market-preview" aria-label="Live CREDIT market">
            <div className="market-preview-head">
              <p className="kicker">
                <span className="live-dot" aria-hidden="true" />
                Live CREDIT market
              </p>
              <p className="market-preview-by">Powered by Orbio</p>
            </div>
            {marketError && <p className="status">{marketError}</p>}
            {market && (
              <div className="preview-body">
                <div className="preview-metric">
                  <span className="preview-value mono">
                    {formatPrice(market.creditPrice)}
                  </span>
                  <span className="preview-label">CREDIT price · USDG</span>
                </div>
                <div className="preview-metric featured">
                  <span className="preview-value mono">
                    {market.bestDiscount}%
                  </span>
                  <span className="preview-label">Best available discount</span>
                </div>
                <div className="preview-metric">
                  <span className="preview-value mono">
                    {formatCredit(market.totalAvailableCredit)}
                  </span>
                  <span className="preview-label">Available CREDIT</span>
                </div>
              </div>
            )}
            <div className="market-preview-foot">
              <img
                className="market-preview-mark"
                src="/orbio-mark.jpg"
                alt="Orbio"
                width={400}
                height={400}
              />
            </div>
          </aside>
        </section>

        <section className="how" aria-labelledby="how-heading">
          <h2 id="how-heading">How it works</h2>
          <ol className="grid-4">
            <li className="pillar">
              <h3>Watch</h3>
              <p>Monitor CREDIT market conditions.</p>
            </li>
            <li className="pillar">
              <h3>Decide</h3>
              <p>
                Determine whether the current opportunity meets the user&apos;s
                procurement rules.
              </p>
            </li>
            <li className="pillar">
              <h3>Execute</h3>
              <p>Prepare and execute a purchase when conditions allow.</p>
            </li>
            <li className="pillar">
              <h3>Measure</h3>
              <p>Track what happened after each decision.</p>
            </li>
          </ol>
        </section>

        <section className="thesis" aria-label="Product thesis">
          <p className="thesis-copy">
            Orbio makes inference tradable through CREDIT. Ora gives agents a
            smarter way to decide when to acquire it.
          </p>
          <aside className="thesis-diagram" aria-label="Inference, CREDIT, and procurement">
            <ol className="flow-chain">
              <li>
                <span className="flow-kicker">Traditional</span>
                <p>
                  <span>Inference</span>
                  <span className="flow-arrow" aria-hidden="true">
                    →
                  </span>
                  <span>API expense</span>
                </p>
              </li>
              <li>
                <span className="flow-kicker">Orbio</span>
                <p>
                  <span>Inference</span>
                  <span className="flow-arrow" aria-hidden="true">
                    →
                  </span>
                  <span>Tradable CREDIT</span>
                </p>
              </li>
              <li>
                <span className="flow-kicker">Ora</span>
                <p>
                  <span>CREDIT</span>
                  <span className="flow-arrow" aria-hidden="true">
                    →
                  </span>
                  <span>Procurement decision</span>
                </p>
              </li>
            </ol>
          </aside>
        </section>

        <section className="landing-docs" id="docs" aria-labelledby="docs-heading">
          <h2 id="docs-heading">Docs</h2>
          <p>
            Understand how Ora observes the CREDIT market, makes procurement
            decisions, executes purchases, and measures outcomes.
          </p>
          <p>
            <a className="btn secondary" href="/docs">
              Docs <span aria-hidden="true">→</span>
            </a>
          </p>
        </section>
      </main>
    </div>
  );
}
