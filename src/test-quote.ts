import { quoteForCredit } from "../lib/orbio/exchange";

const quote = await quoteForCredit(5);
console.log(JSON.stringify(quote, null, 2));
if (quote.creditOut <= 0) {
  throw new Error("Quote returned no CREDIT");
}
