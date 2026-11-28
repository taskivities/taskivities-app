// Calendar dates are plain 'YYYY-MM-DD' strings everywhere. No time zones involved
// except todayIn(), which answers "what date is it right now where this person is?".

export const MONS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const parseDate = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const toDate = (dt: Date): string =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
export const addDays = (s: string, n: number): string => {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return toDate(d);
};
/** a − b in days */
export const diffDays = (a: string, b: string): number => Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / 86400000);
export const weekStart = (s: string): string => {
  const d = parseDate(s);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDate(d);
};
export const monthStart = (s: string): string => s.slice(0, 8) + '01';
export const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toDate(parseDate(s)) === s;

/** "Wed, Nov 4" */
export const fmt = (s: string): string => {
  const d = parseDate(s);
  return `${DOW[d.getDay()]}, ${MONS[d.getMonth()]} ${d.getDate()}`;
};
/** "Today", "Tomorrow", "Yesterday" or "Wed, Nov 4" */
export const rel = (s: string, today: string): string =>
  s === today ? 'Today' : s === addDays(today, 1) ? 'Tomorrow' : s === addDays(today, -1) ? 'Yesterday' : fmt(s);

/** The date of a moment (ISO timestamp) in a time zone, as YYYY-MM-DD. */
export const dayIn = (tz: string, iso: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** Today's date in a time zone, as YYYY-MM-DD. */
export const todayIn = (tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
