import { config } from "dotenv";
import { readMarketSnapshot } from "../lib/orbio/market";
import { decide, DEFAULT_PARAMS } from "../lib/ora/decision";

config({ path: ".env.local" });

const market = await readMarketSnapshot();
const decision = decide(market, DEFAULT_PARAMS);

console.log(JSON.stringify({ market, decision }, null, 2));
