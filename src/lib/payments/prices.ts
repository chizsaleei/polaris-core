import { log } from "../logger";
import type { PlanKey } from "../constants";
import { getDefaultCurrency, getFxSpec, normalizeCurrencyCode, type Currency } from "./currency";

const USD_BASE: Record<PlanKey, number> = {
  pro_monthly: 1299,
  pro_yearly: 9900,
  vip_monthly: 2900,
  vip_yearly: 19900,
};

const MANUAL_PRICE_TABLE: Partial<Record<Currency, Partial<Record<PlanKey, number>>>> = {
  // Provide overrides per currency/plan here when you need a fixed amount
  PHP: {
    pro_monthly: 72900,
    pro_yearly: 554000,
    vip_monthly: 162600,
    vip_yearly: 1114400,
  },
};

export function getPlanPriceUsdCents(plan: PlanKey): number {
  return USD_BASE[plan];
}

export function getPlanPriceCents(plan: PlanKey, currency: Currency): number {
  const normalized = normalizeCurrencyCode(currency, getDefaultCurrency());
  const override = readOverride(plan, normalized);
  if (override != null) return override;
  return convertUsdCentsToCurrencyUnits(USD_BASE[plan], normalized).minorUnits;
}

export interface PlanPriceSummary {
  plan: PlanKey;
  amountUsd: number;
  usdCents: number;
  displayAmount: number;
  displayCurrency: Currency;
  displayCents: number;
  formatted: string;
}

export function getPlanPriceSummary(plan: PlanKey, currency?: string | null): PlanPriceSummary {
  const displayCurrency = normalizeCurrencyCode(currency, getDefaultCurrency());
  const usdCents = USD_BASE[plan];
  const usdAmount = usdCents / 100;
  const override = readOverride(plan, displayCurrency);
  const spec = getFxSpec(displayCurrency);
  const conversion = convertUsdCentsToCurrencyUnits(usdCents, displayCurrency);
  const displayCents = override ?? conversion.minorUnits;
  const displayAmount =
    override != null ? override / 10 ** spec.fractionDigits : conversion.roundedMajor;
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: displayCurrency,
    minimumFractionDigits: spec.fractionDigits,
    maximumFractionDigits: spec.fractionDigits,
  }).format(displayAmount);

  return {
    plan,
    amountUsd: usdAmount,
    usdCents,
    displayAmount,
    displayCurrency,
    displayCents,
    formatted,
  };
}

function readOverride(plan: PlanKey, currency: Currency): number | null {
  const envKey = `PRICE_${currency}_${plan.toUpperCase()}_CENTS`;
  const raw = process.env[envKey as keyof NodeJS.ProcessEnv];
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    throw new Error(`Invalid price in ${envKey}: ${raw}`);
  }
  const manual = MANUAL_PRICE_TABLE[currency]?.[plan];
  if (typeof manual === "number" && manual > 0) {
    return Math.floor(manual);
  }
  return null;
}

function convertUsdCentsToCurrencyUnits(
  usdCents: number,
  currency: Currency,
): { minorUnits: number; roundedMajor: number } {
  const usdMajor = usdCents / 100;
  const spec = getFxSpec(currency);
  if (!spec) {
    log.warn("Missing FX spec for currency, falling back to USD", { currency });
    return { minorUnits: usdCents, roundedMajor: usdMajor };
  }
  const roundedMajor = roundTo(usdMajor * spec.rate, spec.fractionDigits);
  const minorUnits = Math.round(roundedMajor * 10 ** spec.fractionDigits);
  return { minorUnits, roundedMajor };
}

function roundTo(amount: number, fractionDigits: number): number {
  const factor = 10 ** fractionDigits;
  return Math.round(amount * factor) / factor;
}
