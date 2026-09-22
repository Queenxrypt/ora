"use client";

import { useEffect, useState } from "react";

const ITEMS = [
  { id: "what-is-ora", num: "01", label: "What is Ora?" },
  { id: "how-ora-decides", num: "02", label: "How Ora decides" },
  { id: "market-data", num: "03", label: "Market data" },
  { id: "purchase-review", num: "04", label: "Purchase review" },
  { id: "execution", num: "05", label: "Execution" },
  { id: "decision-history", num: "06", label: "Decision history" },
  { id: "performance", num: "07", label: "Performance" },
  { id: "limitations", num: "08", label: "Limitations" },
] as const;

export function DocsToc() {
  const [active, setActive] = useState<string>(ITEMS[0].id);

  useEffect(() => {
    const nodes = ITEMS.map((item) => document.getElementById(item.id)).filter(
      (node): node is HTMLElement => Boolean(node),
    );
    if (nodes.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const id = visible[0]?.target.id;
        if (id) setActive(id);
      },
      { rootMargin: "0px 0px -62% 0px", threshold: [0.1, 0.25, 0.6] },
    );

    for (const node of nodes) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <nav className="docs-toc" aria-label="On this page">
      <p className="docs-toc-kicker">On this page</p>
      <ol>
        {ITEMS.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              className={active === item.id ? "is-active" : undefined}
            >
              <span className="docs-toc-num mono">{item.num}</span>
              <span>{item.label}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
