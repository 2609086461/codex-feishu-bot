import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CODEX_PRICING_URL = "https://learn.chatgpt.com/docs/pricing.md";
const REFRESH_MS = 24 * 60 * 60 * 1_000;
const RETRY_MS = 60 * 60 * 1_000;

export interface ModelCreditRate {
  input: number;
  cachedInput: number;
  output: number;
}

export type ModelCreditRates = Record<string, ModelCreditRate>;

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").trim();
}

/** Only parse the official Standard Codex credit table, never API dollar prices. */
export function parseCodexCreditRates(document: string): ModelCreditRates {
  const section = document.split(/#{2,6}\s+Token rates\s*\n/i)[1]?.split(/\n#{2,6}\s/)[0];
  if (!section) throw new Error("官方 Codex 费率章节缺失");
  const rates: ModelCreditRates = {};
  const rows = [...section.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => plainText(cell[1]!)));
  for (const line of section.split("\n")) {
    if (/^\s*\|/.test(line)) rows.push(line.split("|").slice(1, -1).map(plainText));
  }
  for (const cells of rows) {
    if (cells.length !== 4 || !/^GPT-[\d.]+(?:\s+[a-z]+)?$/i.test(cells[0]!)) continue;
    const values = cells.slice(1).map((cell) => {
      const match = cell.match(/^([\d,.]+)\s+credits?$/i);
      return match ? Number(match[1]!.replace(/,/g, "")) : NaN;
    });
    if (!values.every((value) => Number.isFinite(value) && value >= 0)) continue;
    const slug = cells[0]!.toLowerCase().replace(/\s+/g, "-");
    rates[slug] = { input: values[0]!, cachedInput: values[1]!, output: values[2]! };
  }
  if (!Object.keys(rates).length) throw new Error("官方 Codex 费率表无法解析");
  return rates;
}

interface Snapshot {
  source: string;
  fetchedAt: number;
  rates: ModelCreditRates;
}

export class CodexPricingCatalog {
  private snapshot?: Snapshot;
  private nextAttemptAt = 0;
  private pending?: Promise<ModelCreditRates>;
  private loaded = false;

  constructor(
    private readonly cacheFile: string,
    private readonly fetchDocument = async (): Promise<string> => {
      const response = await fetch(CODEX_PRICING_URL, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error(`官方费率请求失败：HTTP ${response.status}`);
      const document = await response.text();
      if (document.length > 1_000_000) throw new Error("官方费率文档过大");
      return document;
    },
    private readonly now = Date.now,
    private readonly onWarning?: (message: string) => void
  ) {}

  async getRates(): Promise<ModelCreditRates> {
    if (this.pending) return this.pending;
    this.pending = this.refresh();
    try { return await this.pending; } finally { this.pending = undefined; }
  }

  private async refresh(): Promise<ModelCreditRates> {
    if (!this.loaded) {
      this.loaded = true;
      try {
        const cached = JSON.parse(await readFile(this.cacheFile, "utf8")) as Snapshot;
        if (cached.source === CODEX_PRICING_URL && Number.isFinite(cached.fetchedAt) &&
          cached.rates && Object.keys(cached.rates).length &&
          Object.values(cached.rates).every((rate) => [rate?.input, rate?.cachedInput, rate?.output]
            .every((value) => Number.isFinite(value) && value >= 0))) {
          this.snapshot = cached;
        }
      } catch { /* A missing/corrupt cache triggers a fresh fetch. */ }
    }
    const now = this.now();
    if ((this.snapshot && now - this.snapshot.fetchedAt < REFRESH_MS) || now < this.nextAttemptAt) {
      return this.snapshot?.rates ?? {};
    }
    try {
      const rates = parseCodexCreditRates(await this.fetchDocument());
      this.snapshot = { source: CODEX_PRICING_URL, fetchedAt: now, rates };
      try {
        await mkdir(dirname(this.cacheFile), { recursive: true });
        const temporary = `${this.cacheFile}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(this.snapshot), { mode: 0o600 });
        await rename(temporary, this.cacheFile);
      } catch { this.onWarning?.("费率已刷新，但本地缓存无法保存"); }
      return rates;
    } catch (error) {
      this.nextAttemptAt = now + RETRY_MS;
      this.onWarning?.(`费率刷新失败，沿用上次有效费率；缺失项标记未知：${error instanceof Error ? error.message : String(error)}`);
      return this.snapshot?.rates ?? {};
    }
  }
}
