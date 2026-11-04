import type { Row } from "@weir/daemon/Api";

export type Plan = Row["plan"];

export type Today = { readonly date: string; readonly minute: number };

export type Dated = Extract<Plan, { readonly _tag: "Day" | "Slot" }>;

export type Parsed<A> =
  | { readonly _tag: "Ok"; readonly value: A; readonly preview: string }
  | { readonly _tag: "Bad"; readonly why: string };

const dayMs = 86_400_000;
const minuteMs = 60_000;
const dayMinutes = 1440;
export const slotMinutes = 30;

const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const monthNames = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;
const monthLong = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const epoch = (date: string) => Date.parse(`${date}T00:00:00Z`);
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const pad = (n: number) => String(n).padStart(2, "0");

export const addDays = (date: string, n: number) => isoDay(epoch(date) + n * dayMs);

export const daysBetween = (from: string, to: string) =>
  Math.round((epoch(to) - epoch(from)) / dayMs);

export const weekdayOf = (date: string) => new Date(epoch(date)).getUTCDay();

const monthLength = (year: number, month: number) =>
  new Date(Date.UTC(year, month, 0)).getUTCDate();

const makeDate = (year: number, month: number, day: number) =>
  month < 1 || month > 12 || day < 1 || day > monthLength(year, month)
    ? null
    : `${year}-${pad(month)}-${pad(day)}`;

export const clock = (minute: number) => `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;

export const monthDay = (date: string, today: string) =>
  `${monthNames[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}${date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${date.slice(0, 4)}`}`;

export const dayName = (date: string, today: string) =>
  `${weekdays[weekdayOf(date)]} ${monthDay(date, today)}`;

const dayWord = (date: string, today: string) => {
  const ahead = daysBetween(today, date);
  if (ahead <= 0) return "today";
  if (ahead === 1) return "tomorrow";
  if (ahead < 7) return weekdays[weekdayOf(date)];
  return monthDay(date, today);
};

export const planLabel = (plan: Plan, today: string) => {
  switch (plan._tag) {
    case "None":
      return null;
    case "Tray":
      return "In the Tray";
    case "Day":
      return `Planned ${dayWord(plan.date, today)}`;
    case "Slot":
      return `Planned ${dayWord(plan.date, today)} ${clock(plan.start)}`;
  }
};

export const planText = (plan: Exclude<Plan, { readonly _tag: "None" }>, today: string) => {
  switch (plan._tag) {
    case "Tray":
      return "In the Tray";
    case "Day":
      return `Planned for ${dayName(plan.date, today)}`;
    case "Slot":
      return `Planned for ${dayName(plan.date, today)}, ${clock(plan.start)}`;
  }
};

export const overdueDays = (due: string, today: string) => Math.max(0, daysBetween(due, today));

export const dueFlag = (due: string, today: string) => {
  const over = overdueDays(due, today);
  const label = `Due ${monthDay(due, today)}`;
  return {
    over: over > 0,
    text: over === 0 ? label : `${label} · ${over === 1 ? "1 day" : `${over} days`} over`,
  };
};

export const todayOf = (anchor: Today, elapsedMs: number): Today => {
  const total = anchor.minute + Math.floor(Math.max(0, elapsedMs) / minuteMs);
  return {
    date: addDays(anchor.date, Math.floor(total / dayMinutes)),
    minute: total % dayMinutes,
  };
};

export const monthOf = (date: string) => date.slice(0, 7);

export const addMonths = (month: string, n: number) => {
  const total = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
};

export const monthTitle = (month: string) =>
  `${monthLong[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export const monthDates = (month: string) => {
  const first = `${month}-01`;
  const count = monthLength(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  return {
    lead: (weekdayOf(first) + 6) % 7,
    dates: Array.from({ length: count }, (_, at) => addDays(first, at)),
  };
};

const fillers = /\b(at|on|the|by|for|of|around|from)\b/g;
const weekdayIndex: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};
const monthIndex: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const numberWords: Readonly<Record<string, number>> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const examples = "Try thu 3pm, nov 12, next mon 9:30 or in 2 weeks.";
const noDate = "That date doesn't exist.";
const noTime = "That time doesn't exist.";
const afternoon = (hour: number) => (hour >= 1 && hour < 7 ? hour + 12 : hour);

export const parseWhen = (text: string, now: Today): Parsed<Dated> | null => {
  let rest = ` ${text.toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim()} `;
  if (rest.trim() === "") return null;
  const today = now.date;
  let date: string | null = null;
  let time: number | null = null;
  let bad: string | null = null;
  const take = (pattern: RegExp, read: (match: RegExpMatchArray) => void) => {
    const match = rest.match(pattern);
    if (match === null || match.index === undefined) return;
    read(match);
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`;
  };
  const setDate = (next: string | null) => {
    if (next === null) bad = noDate;
    else date = next;
  };
  const setTime = (hour: number, minute: number) => {
    if (hour > 23 || minute > 59) bad = noTime;
    else time = hour * 60 + minute;
  };
  const upcoming = (month: number, day: number) => {
    const year = Number(today.slice(0, 4));
    const next = makeDate(year, month, day);
    if (next === null) return null;
    return next < today ? makeDate(year + 1, month, day) : next;
  };
  const part = (match: RegExpMatchArray, at: number) => match[at] ?? "";
  take(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) =>
    setDate(makeDate(Number(part(m, 1)), Number(part(m, 2)), Number(part(m, 3)))),
  );
  take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => {
    const year = m[3];
    setDate(
      year === undefined
        ? upcoming(Number(part(m, 1)), Number(part(m, 2)))
        : makeDate(
            year.length === 2 ? 2000 + Number(year) : Number(year),
            Number(part(m, 1)),
            Number(part(m, 2)),
          ),
    );
  });
  take(
    /\bin (\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten) (days?|weeks?|wks?|months?)\b/,
    (m) => {
      const count = numberWords[part(m, 1)] ?? Number(part(m, 1));
      const unit = part(m, 2);
      if (unit.startsWith("m")) {
        const month = addMonths(monthOf(today), count);
        const year = Number(month.slice(0, 4));
        const index = Number(month.slice(5, 7));
        setDate(
          makeDate(year, index, Math.min(Number(today.slice(8, 10)), monthLength(year, index))),
        );
      } else setDate(addDays(today, count * (unit.startsWith("d") ? 1 : 7)));
    },
  );
  take(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/,
    (m) => setDate(upcoming(monthIndex[part(m, 1)] ?? 0, Number(part(m, 2)))),
  );
  take(
    /\b(\d{1,2})(?:st|nd|rd|th)? (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/,
    (m) => setDate(upcoming(monthIndex[part(m, 2)] ?? 0, Number(part(m, 1)))),
  );
  take(/\bnext week\b/, () => setDate(addDays(today, (8 - weekdayOf(today)) % 7 || 7)));
  take(/\b(today|tonight)\b/, (m) => {
    setDate(today);
    if (part(m, 1) === "tonight" && time === null) time = 19 * 60;
  });
  take(/\b(tomorrow|tmrw|tmr)\b/, () => setDate(addDays(today, 1)));
  take(/\b(next |this )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/, (m) => {
    const ahead = ((weekdayIndex[part(m, 2)] ?? 0) - weekdayOf(today) + 7) % 7;
    if (m[1] === "this ") return setDate(addDays(today, ahead));
    const next = ahead === 0 ? 7 : ahead;
    setDate(
      addDays(today, m[1] === "next " && next + ((weekdayOf(today) + 6) % 7) < 7 ? next + 7 : next),
    );
  });
  take(/\bnoon\b/, () => {
    time = 12 * 60;
  });
  take(/\bmorning\b/, () => {
    time = 9 * 60;
  });
  take(/\bafternoon\b/, () => {
    time = 14 * 60;
  });
  take(/\bevening\b/, () => {
    time = 18 * 60;
  });
  take(/\b(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)\b/, (m) => {
    const hour = Number(part(m, 1));
    const minute = Number(m[2] ?? 0);
    if (hour < 1 || hour > 12) bad = noTime;
    else setTime((hour % 12) + (part(m, 3).startsWith("p") ? 12 : 0), minute);
  });
  take(/\b(\d{1,2}):(\d{2})\b/, (m) => {
    const hour = Number(part(m, 1));
    setTime(hour > 23 ? hour : afternoon(hour), Number(part(m, 2)));
  });
  take(/\bat ([01]?\d|2[0-3])\b/, (m) => {
    time = afternoon(Number(part(m, 1))) * 60;
  });
  if (bad !== null) return { _tag: "Bad", why: bad };
  let left = rest
    .replace(fillers, " ")
    .replace(/[.\s]+/g, " ")
    .trim();
  if (/^\d{1,2}$/.test(left) && date !== null && time === null && Number(left) <= 23) {
    time = afternoon(Number(left)) * 60;
    left = "";
  }
  if (left !== "") return { _tag: "Bad", why: `Can't read “${left}” yet. ${examples}` };
  if (date === null && time === null)
    return { _tag: "Bad", why: `Can't read that yet. ${examples}` };
  const day: string = date ?? (time !== null && time > now.minute ? today : addDays(today, 1));
  if (day < today || (day === today && time !== null && time < now.minute)) {
    return {
      _tag: "Bad",
      why: `That's already behind you. It's ${clock(now.minute)} on ${dayName(today, today)}.`,
    };
  }
  return time === null
    ? {
        _tag: "Ok",
        value: { _tag: "Day", date: day },
        preview: `${dayName(day, today)} · any time`,
      }
    : {
        _tag: "Ok",
        value: { _tag: "Slot", date: day, start: time, minutes: slotMinutes },
        preview: `${dayName(day, today)}, ${clock(time)}`,
      };
};

export const parseDue = (text: string, now: Today): Parsed<string> | null => {
  const parsed = parseWhen(text, now);
  if (parsed === null || parsed._tag === "Bad") return parsed;
  if (parsed.value._tag === "Slot") {
    return { _tag: "Bad", why: "A due date has no time. Try fri, nov 12 or in 2 weeks." };
  }
  return {
    _tag: "Ok",
    value: parsed.value.date,
    preview: dayName(parsed.value.date, now.date),
  };
};
