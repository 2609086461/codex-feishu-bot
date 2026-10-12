import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CodexPricingCatalog, parseCodexCreditRates } from "./model-pricing.js";

const officialFormat = `API dollars and plan message limits must not become credit rates.
<table><tr><td>GPT-6.1 Sol</td><td>$2</td><td>$0.1</td><td>$10</td></tr></table>
#### Token rates
Rates for Standard speed.
<table><thead><tr><th>Credits per 1M tokens</th></tr></thead><tbody>
<tr><td>GPT-6.1 Sol</td><td>50 credits</td><td>2.5 credits</td><td>250 credits</td></tr>
<tr><td>GPT-5.6 Sol</td><td>100 credits</td><td>10 credits</td><td>500 credits</td></tr>
<tr><td>GPT-7.2 Sol</td><td>40 credits</td><td>2 credits</td><td>200 credits</td></tr>
<tr><td>GPT-Image-2 (image)</td><td>200 credits</td><td>50 credits</td><td>750 credits</td></tr>
</tbody></table>
## Other charges
<table><tr><td>GPT-6.1 Sol</td><td>1 credits</td><td>1 credits</td><td>1 credits</td></tr></table>`;

test("credit parsing discovers future models and ignores other billing tables", () => {
  const rates = parseCodexCreditRates(officialFormat);
  assert.deepEqual(rates["gpt-6.1-sol"], { input: 50, cachedInput: 2.5, output: 250 });
  assert.deepEqual(rates["gpt-7.2-sol"], { input: 40, cachedInput: 2, output: 200 });
  assert.equal(Object.keys(rates).length, 3);
  assert.throws(() => parseCodexCreditRates("changed page layout"));
});

test("pricing supports Markdown tables and rejects malformed numeric rates", () => {
  const rates = parseCodexCreditRates(`#### Token rates
| Model | Input | Cached input | Output |
| GPT-7 Sol | 200 credits | 20 credits | 1,250 credits |
| GPT-8 Sol | 1.2.3 credits | 1 credits | 2 credits |
| GPT-9 Sol | unknown | unknown | unknown |`);
  assert.deepEqual(rates["gpt-7-sol"], { input: 200, cachedInput: 20, output: 1250 });
  assert.equal(rates["gpt-8-sol"], undefined);
  assert.equal(rates["gpt-9-sol"], undefined);
});

test("pricing refreshes daily, persists across restart and tolerates upstream failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pricing-"));
  try {
    const path = join(directory, "pricing.json");
    let now = Date.now();
    let calls = 0;
    const warnings: string[] = [];
    const fetcher = async () => { calls++; return officialFormat; };
    const catalog = new CodexPricingCatalog(path, fetcher, () => now);
    await Promise.all([catalog.getRates(), catalog.getRates()]);
    assert.equal(calls, 1);
    const restarted = new CodexPricingCatalog(path, fetcher, () => now);
    assert.equal((await restarted.getRates())["gpt-7.2-sol"]?.input, 40);
    assert.equal(calls, 1);
    now += 25 * 60 * 60 * 1000;
    await restarted.getRates();
    assert.equal(calls, 2);
    now += 25 * 60 * 60 * 1000;
    const offline = new CodexPricingCatalog(path, async () => { calls++; throw new Error("offline"); }, () => now,
      (message) => warnings.push(message));
    assert.equal((await offline.getRates())["gpt-6.1-sol"]?.input, 50);
    await offline.getRates();
    assert.equal(calls, 3, "upstream failure must have a retry backoff");
    assert.match(warnings[0]!, /沿用上次有效费率/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("first-time outage returns unknown prices, never fabricated zero rates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-pricing-outage-"));
  try {
    const catalog = new CodexPricingCatalog(join(directory, "missing.json"), async () => { throw new Error("offline"); });
    assert.deepEqual(await catalog.getRates(), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});
