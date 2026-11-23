export const DAY = 86_400_000;

// How far the zone is ahead of UTC at that instant, in ms.
export function tzOffsetMs(tz, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

// Midnight in the zone, `daysAgo` days back, as a UTC Date.
export function startOfDay(tz, now = new Date(), daysAgo = 0) {
  const off = tzOffsetMs(tz, now);
  const local = new Date(now.getTime() + off);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - daysAgo);
  let utc = midnight - off;
  const off2 = tzOffsetMs(tz, new Date(utc)); // the offset can differ across a clock change
  if (off2 !== off) utc = midnight - off2;
  return new Date(utc);
}

// Monday 00:00 in the zone.
export function startOfWeek(tz, now = new Date()) {
  const local = new Date(now.getTime() + tzOffsetMs(tz, now));
  return startOfDay(tz, now, (local.getUTCDay() + 6) % 7);
}

// YYYY-MM-DD in the zone.
export const localDate = (tz, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

// The monthly period containing `now`, anchored to a day of the month (clamped for short months).
export function monthlyPeriod(anchorDay, now = new Date()) {
  const at = (y, m) => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(anchorDay, last)));
  };
  let start = at(now.getUTCFullYear(), now.getUTCMonth());
  if (start > now) start = at(now.getUTCFullYear(), now.getUTCMonth() - 1);
  return { start, end: at(start.getUTCFullYear(), start.getUTCMonth() + 1) };
}
