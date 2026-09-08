/**
 * Cost projection.
 *
 * Staying watched and connected is a recurring charge, not a one-time setup
 * fee, so every number a user sees comes from an explicit charge schedule
 * rather than a rule of thumb.
 *
 * Two different cadences drive the cost:
 *   - Renewals EXTEND the existing lease by WINDOW minutes from its current
 *     expiry, so renewing 15 minutes early buys a safety margin for free and
 *     the steady-state cadence stays one renewal per WINDOW.
 *   - Sessions are REPLACED, not extended, so re-buying 5 minutes before
 *     expiry genuinely shortens the cadence from 30 to 25 minutes. That extra
 *     cost is real and is priced here rather than rounded away.
 */

import {
  BUDGET_SAFETY_MARGIN,
  CONTRACT,
  PRICE_ATOMIC,
  RENEW_LEAD_SEC,
  SESSION_REBUY_LEAD_SEC,
} from "./constants.mjs";

const WINDOW_MIN = CONTRACT.leaseWindowMinutes;
const SESSION_TTL_MIN = CONTRACT.sessionTtlMinutes;
const RENEW_LEAD_MIN = RENEW_LEAD_SEC / 60;
const SESSION_LEAD_MIN = SESSION_REBUY_LEAD_SEC / 60;

/** Wall-clock minutes between successive paid session purchases. */
export const SESSION_CADENCE_MIN = SESSION_TTL_MIN - SESSION_LEAD_MIN;

/** Wall-clock minutes between successive paid renewals, in steady state. */
export const RENEW_CADENCE_MIN = WINDOW_MIN;

function renewCount(minutes) {
  if (minutes <= WINDOW_MIN) return 0;
  return Math.ceil((minutes - WINDOW_MIN) / WINDOW_MIN);
}

function sessionCount(minutes) {
  if (minutes <= SESSION_TTL_MIN) return 1;
  return Math.ceil((minutes - SESSION_TTL_MIN) / SESSION_CADENCE_MIN) + 1;
}

/**
 * Build the ordered charge schedule for a run.
 * Times are minutes from supervisor start.
 */
export function buildSchedule(tickers, hours) {
  const minutes = Math.max(0, hours) * 60;
  const events = [];

  if (tickers > 0) {
    events.push({
      minute: 0,
      kind: "start",
      count: tickers,
      atomic: PRICE_ATOMIC.start * BigInt(tickers),
    });
  }
  events.push({ minute: 0, kind: "session", count: 1, atomic: PRICE_ATOMIC.session });

  const renews = renewCount(minutes);
  for (let k = 0; k < renews; k += 1) {
    events.push({
      minute: WINDOW_MIN - RENEW_LEAD_MIN + k * RENEW_CADENCE_MIN,
      kind: "renew",
      count: tickers,
      atomic: PRICE_ATOMIC.renew * BigInt(tickers),
    });
  }

  const sessions = sessionCount(minutes);
  for (let j = 1; j < sessions; j += 1) {
    events.push({
      minute: j * SESSION_CADENCE_MIN,
      kind: "session",
      count: 1,
      atomic: PRICE_ATOMIC.session,
    });
  }

  events.sort((a, b) => a.minute - b.minute || a.kind.localeCompare(b.kind));
  return events;
}

export function totalAtomic(tickers, hours) {
  return buildSchedule(tickers, hours).reduce((sum, e) => sum + e.atomic, 0n);
}

/**
 * Project a run and derive the cap the user would need.
 *
 * The busiest 24 hours are the first 24, because that window carries the
 * one-time watch starts, so the recommended cap is based on it.
 */
export function projectRun(tickers, hours) {
  const schedule = buildSchedule(tickers, hours);
  const total = schedule.reduce((sum, e) => sum + e.atomic, 0n);
  const busiestDay = totalAtomic(tickers, Math.min(hours, 24));
  const steadyDay = totalAtomic(tickers, 24);
  const recommendedCap =
    (busiestDay * BigInt(Math.round(BUDGET_SAFETY_MARGIN * 100))) / 100n;

  const counts = schedule.reduce(
    (acc, e) => {
      acc[e.kind] = (acc[e.kind] || 0) + 1;
      return acc;
    },
    {}
  );

  return {
    tickers,
    hours,
    schedule,
    totalAtomic: total,
    busiestDayAtomic: busiestDay,
    steadyDayAtomic: steadyDay,
    recommendedCapAtomic: recommendedCap,
    weekFundingAtomic: steadyDay * 7n,
    counts: {
      start: counts.start || 0,
      renew: counts.renew || 0,
      session: counts.session || 0,
    },
    cadence: {
      renew_minutes: RENEW_CADENCE_MIN,
      session_minutes: SESSION_CADENCE_MIN,
      note:
        "Renewals extend the lease from its current expiry, so early renewal is free. " +
        "Sessions are replaced, so the pre-expiry re-buy shortens session cadence to " +
        `${SESSION_CADENCE_MIN} minutes.`,
    },
  };
}

/**
 * How long a run actually lasts under a given daily cap.
 * Returns the wall-clock hours covered before the cap blocks the next charge.
 */
export function hoursAffordable(capAtomic, tickers, maxHours = 24) {
  const schedule = buildSchedule(tickers, maxHours);
  let spent = 0n;
  for (const event of schedule) {
    if (spent + event.atomic > capAtomic) {
      return Math.max(0, event.minute / 60);
    }
    spent += event.atomic;
  }
  return maxHours;
}

/** Charges expected in the next `withinMinutes`, for the status report. */
export function nextCharges(tickers, sinceMinute, withinMinutes) {
  return buildSchedule(tickers, (sinceMinute + withinMinutes) / 60).filter(
    (e) => e.minute >= sinceMinute && e.minute <= sinceMinute + withinMinutes
  );
}
