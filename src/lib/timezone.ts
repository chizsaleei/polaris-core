/**
 * Lightweight timezone helpers built on Intl.DateTimeFormat.
 * Keeps cron jobs and schedulers free from third-party deps.
 */

export interface TimezoneInfo {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekdayIso: number; // 1 = Monday ... 7 = Sunday
  offsetMs: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  const key = timezone || "UTC";
  let fmt = dtfCache.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: key,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      weekday: "short",
    });
    dtfCache.set(key, fmt);
  }
  return fmt;
}

const WEEKDAY_TO_ISO: Record<string, number> = {
  Sun: 7,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function isWeekdayKey(value: string): value is keyof typeof WEEKDAY_TO_ISO {
  return Object.prototype.hasOwnProperty.call(WEEKDAY_TO_ISO, value);
}

export function getTimezoneInfo(date: Date, timezone: string): TimezoneInfo {
  const fmt = getFormatter(timezone);
  const parts = fmt.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour ?? 0);
  const minute = Number(map.minute ?? 0);
  const second = Number(map.second ?? 0);
  const weekdayRaw = map.weekday;
  const weekdayIso = typeof weekdayRaw === "string" && isWeekdayKey(weekdayRaw) ? WEEKDAY_TO_ISO[weekdayRaw] : WEEKDAY_TO_ISO.Mon;

  const zonedUtcMillis = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMs = zonedUtcMillis - date.getTime();

  return { year, month, day, hour, minute, second, weekdayIso, offsetMs };
}

export function startOfDayInTimezone(date: Date, timezone: string): Date {
  const info = getTimezoneInfo(date, timezone);
  const midnightUtc = Date.UTC(info.year, info.month - 1, info.day, 0, 0, 0) - info.offsetMs;
  return new Date(midnightUtc);
}

export function startOfIsoWeekInTimezone(date: Date, timezone: string): Date {
  const startOfDay = startOfDayInTimezone(date, timezone);
  const info = getTimezoneInfo(date, timezone);
  const daysToSubtract = info.weekdayIso - 1;
  return addDays(startOfDay, -daysToSubtract);
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function daysAgoInTimezone(base: Date, days: number, timezone: string): Date {
  const start = startOfDayInTimezone(base, timezone);
  return addDays(start, -Math.floor(days));
}

export function formatYmdInTimezone(dateInput?: Date | string, timezone?: string): string {
  const date = toDate(dateInput);
  const info = getTimezoneInfo(date, timezone || "UTC");
  const yy = info.year;
  const mm = String(info.month).padStart(2, "0");
  const dd = String(info.day).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

export function toDate(input?: Date | string): Date {
  if (input instanceof Date) return new Date(input.getTime());
  if (typeof input === "string") return new Date(input);
  return new Date();
}
