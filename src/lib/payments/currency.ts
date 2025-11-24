import { log } from "../logger";

/**
 * Central currency helpers used by payments, pricing, and affiliate payouts.
 * Keep all currency decisions in this module so adapters and routes stay small.
 */

const SUPPORTED_CURRENCIES = [
  "USD",
  "PHP",
  "CNY",
  "INR",
  "KRW",
  "VND",
  "THB",
  "IDR",
  "JPY",
  "BRL",
  "MXN",
  "TRY",
  "COP",
  "ARS",
  "PEN",
  "CLP",
  "SAR",
  "AED",
  "QAR",
  "KWD",
  "EGP",
  "PKR",
  "BDT",
  "NPR",
  "LKR",
  "MMK",
  "KZT",
  "UAH",
  "MAD",
  "DZD",
  "ETB",
] as const;

const SUPPORTED_SET = new Set<string>(SUPPORTED_CURRENCIES);

export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const COUNTRY_TO_CURRENCY: Record<string, Currency> = {
  US: "USD",
  CA: "USD",
  CN: "CNY",
  IN: "INR",
  KR: "KRW",
  VN: "VND",
  TH: "THB",
  PH: "PHP",
  ID: "IDR",
  JP: "JPY",
  BR: "BRL",
  MX: "MXN",
  TR: "TRY",
  CO: "COP",
  AR: "ARS",
  PE: "PEN",
  CL: "CLP",
  SA: "SAR",
  AE: "AED",
  QA: "QAR",
  KW: "KWD",
  EG: "EGP",
  PK: "PKR",
  BD: "BDT",
  NP: "NPR",
  LK: "LKR",
  MM: "MMK",
  KZ: "KZT",
  UA: "UAH",
  MA: "MAD",
  DZ: "DZD",
  ET: "ETB",
};

const DEFAULT_CURRENCY: Currency = normalizeCurrencyCode(
  process.env.PAYMONGO_DEFAULT_CURRENCY ||
    process.env.DEFAULT_CURRENCY ||
    "USD",
);

type FxSpec = {
  rate: number;
  fractionDigits: number;
};

/**
 * Approximate FX rates for client-side display. These are intentionally coarse
 * and can be tuned without redeploying payment adapters.
 */
const FX_TABLE: Record<Currency, FxSpec> = {
  USD: { rate: 1, fractionDigits: 2 },
  PHP: { rate: 56, fractionDigits: 2 },
  CNY: { rate: 7.2, fractionDigits: 2 },
  INR: { rate: 83, fractionDigits: 2 },
  KRW: { rate: 1330, fractionDigits: 0 },
  VND: { rate: 25000, fractionDigits: 0 },
  THB: { rate: 36.5, fractionDigits: 2 },
  IDR: { rate: 16000, fractionDigits: 0 },
  JPY: { rate: 150, fractionDigits: 0 },
  BRL: { rate: 5.3, fractionDigits: 2 },
  MXN: { rate: 17, fractionDigits: 2 },
  TRY: { rate: 33, fractionDigits: 2 },
  COP: { rate: 4000, fractionDigits: 2 },
  ARS: { rate: 900, fractionDigits: 2 },
  PEN: { rate: 3.8, fractionDigits: 2 },
  CLP: { rate: 950, fractionDigits: 0 },
  SAR: { rate: 3.75, fractionDigits: 2 },
  AED: { rate: 3.67, fractionDigits: 2 },
  QAR: { rate: 3.64, fractionDigits: 2 },
  KWD: { rate: 0.31, fractionDigits: 3 },
  EGP: { rate: 49, fractionDigits: 2 },
  PKR: { rate: 279, fractionDigits: 2 },
  BDT: { rate: 110, fractionDigits: 2 },
  NPR: { rate: 133, fractionDigits: 2 },
  LKR: { rate: 300, fractionDigits: 2 },
  MMK: { rate: 2100, fractionDigits: 0 },
  KZT: { rate: 480, fractionDigits: 2 },
  UAH: { rate: 41, fractionDigits: 2 },
  MAD: { rate: 10, fractionDigits: 2 },
  DZD: { rate: 135, fractionDigits: 2 },
  ETB: { rate: 57, fractionDigits: 2 },
};

export function getSupportedCurrencies(): Currency[] {
  return [...SUPPORTED_CURRENCIES];
}

export function normalizeCurrencyCode(value?: string | null, fallback: Currency = "USD"): Currency {
  if (!value) return fallback;
  const upper = value.trim().toUpperCase();
  if (SUPPORTED_SET.has(upper)) {
    return upper as Currency;
  }
  log.warn("Unsupported currency requested, defaulting to fallback.", {
    currency: value,
    fallback,
  });
  return fallback;
}

export function getDefaultCurrencyForCountry(country?: string | null): Currency {
  if (!country) return DEFAULT_CURRENCY;
  const code = country.trim().toUpperCase();
  const mapped = COUNTRY_TO_CURRENCY[code];
  if (!mapped) {
    log.debug("Unsupported country for currency mapping, using default.", { country: code });
    return DEFAULT_CURRENCY;
  }
  return mapped;
}

/**
 * Resolve the best currency for a user based on (currency, country) hints.
 * Priority: explicit currency -> country default -> configured default.
 */
export function resolveCurrencyHint(hints: { currency?: string | null; country?: string | null }): Currency {
  if (hints.currency) {
    return normalizeCurrencyCode(hints.currency, getDefaultCurrencyForCountry(hints.country));
  }
  return getDefaultCurrencyForCountry(hints.country);
}

/**
 * Convert a USD amount (major unit) into a display currency using coarse FX.
 * Returns both the numeric amount and a formatted string for UI use.
 */
export function convertUsdToDisplayCurrency(usdAmount: number, displayCurrency: Currency): {
  amount: number;
  currency: Currency;
  formatted: string;
} {
  const spec = FX_TABLE[displayCurrency];
  if (!Number.isFinite(usdAmount)) {
    throw new Error("convertUsdToDisplayCurrency requires a finite USD amount");
  }
  const rate = spec?.rate ?? 1;
  const digits = spec?.fractionDigits ?? 2;
  const amount = roundTo(usdAmount * rate, digits);
  const formatter =
    spec &&
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: displayCurrency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });

  return {
    amount,
    currency: displayCurrency,
    formatted: formatter ? formatter.format(amount) : `${displayCurrency} ${amount.toFixed(digits)}`,
  };
}

export function getFxSpec(currency: Currency): FxSpec {
  return FX_TABLE[currency] ?? { rate: 1, fractionDigits: 2 };
}

function roundTo(amount: number, fractionDigits: number): number {
  const factor = 10 ** fractionDigits;
  return Math.round(amount * factor) / factor;
}

export function getDefaultCurrency(): Currency {
  return DEFAULT_CURRENCY;
}

export function resolveProfileCurrency(profile?: { currency_code?: string | null; country_code?: string | null }): Currency {
  return resolveCurrencyHint({
    currency: profile?.currency_code ?? undefined,
    country: profile?.country_code ?? undefined,
  });
}

// Backwards compat helpers (legacy imports still work)
export const currencyForCountry = getDefaultCurrencyForCountry;
