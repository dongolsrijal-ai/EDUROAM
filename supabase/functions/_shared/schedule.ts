// Assignments, deadlines and study planning for the AI tutor: pure functions (no SDK imports),
// unit-tested with node --test. Times are stored as UTC instants plus the student's IANA timezone;
// all wall-clock reasoning (due "tomorrow", 11:59 pm, daylight saving) happens in that timezone.

export const DEFAULT_TIMEZONE = 'UTC';

/** A valid IANA timezone name ("America/New_York"), else null. */
export function validTimeZone (value: unknown): string | null
{
    if (typeof value !== 'string' || !value || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return null;
    // Kept as written (ICU may report an older alias, e.g. Asia/Kolkata as Asia/Calcutta).
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return value; }
    catch { return null; }
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number }

/** The wall-clock time of `instant` in `tz`. */
export function wallClock (instant: Date, tz: string): Wall & { weekday: number }
{
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(instant).map((p) => [p.type, p.value]));
    return {
        year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute),
        weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday),
    };
}

/**
 * The UTC instant of a wall-clock time in `tz`. A time skipped by a daylight-saving jump moves
 * forward by the size of the jump (02:30 -> 03:30); a repeated time resolves to the first one.
 */
export function zonedToUtc (wall: Wall, tz: string): Date
{
    const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    const offsetAt = (ms: number) => { const w = wallClock(new Date(ms), tz); return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) - ms; };
    // Candidates from the offsets around the target; keep the earliest that reads back correctly.
    const candidates = [...new Set([offsetAt(target - 86_400_000), offsetAt(target), offsetAt(target + 86_400_000)])]
        .map((offset) => target - offset).sort((a, b) => a - b);
    for (const ms of candidates)
    {
        const w = wallClock(new Date(ms), tz);
        if (w.year === wall.year && w.month === wall.month && w.day === wall.day && w.hour === wall.hour && w.minute === wall.minute) return new Date(ms);
    }
    // Inside a spring-forward gap: same offset as just before the gap, i.e. shifted by the jump.
    return new Date(target - offsetAt(target - 3 * 3_600_000));
}

/** "Wed 19 Nov, 11:59 PM" in the student's timezone. */
export function formatLocal (instant: Date, tz: string): string
{
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(instant);
}

/** Calendar days from `now` to `due` in the student's timezone (0 = today, 1 = tomorrow, -1 = yesterday). */
export function daysUntil (due: Date, now: Date, tz: string): number
{
    const a = wallClock(now, tz);
    const b = wallClock(due, tz);
    return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** How a teacher would say it: "overdue", "due today at 11:59 PM", "due tomorrow", "due in 4 days". */
export function dueLabel (due: Date, now: Date, tz: string): string
{
    if (due.getTime() < now.getTime()) return 'overdue';
    const days = daysUntil(due, now, tz);
    const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(due);
    if (days === 0) return `due today at ${time}`;
    if (days === 1) return `due tomorrow at ${time}`;
    return `due in ${days} days (${formatLocal(due, tz)})`;
}

/** "2026-11-19 23:59" or "2026-11-19" (end of day) in `tz` -> UTC instant; null if not a real date. */
export function parseLocalDue (value: unknown, tz: string): Date | null
{
    const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(value.trim()) : null;
    if (!m) return null;
    const wall = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: m[4] ? Number(m[4]) : 23, minute: m[5] ? Number(m[5]) : 59 };
    if (wall.month < 1 || wall.month > 12 || wall.hour > 23 || wall.minute > 59) return null;
    const check = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
    if (check.getUTCMonth() !== wall.month - 1 || check.getUTCDate() !== wall.day) return null;
    return zonedToUtc(wall, tz);
}

// ------------------------------------------------------------------ deadlines found in uploaded files

export interface DeadlineSuggestion
{
    /** The sentence the date came from (what the student is asked to confirm). */
    snippet: string;
    /** Parsed due instant, or null when the text names a deadline the parser cannot date. */
    dueAt: string | null;
    /** False when no time was written (end of that day is assumed and must be confirmed). */
    hasTime: boolean;
    documentTitle: string;
    documentId: string;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DUE_WORDS = /\b(due|deadline|submit(?:ted)?\s+by|turn(?:ed)?\s+in\s+by|hand\s+in\s+by|no\s+later\s+than)\b/i;
const DATE = new RegExp([
    String.raw`(?<iso>(?<iy>\d{4})-(?<im>\d{1,2})-(?<id>\d{1,2}))`,
    String.raw`(?<us>(?<um>\d{1,2})/(?<ud>\d{1,2})(?:/(?<uy>\d{2,4}))?)`,
    String.raw`(?<named>(?<nm>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(?<nd>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?<ny>\d{4}))?)`,
].join('|'), 'i');
const TIME = /\b(?:at\s+|by\s+|@\s*)?(?<h>\d{1,2})(?::(?<mi>\d{2}))?\s*(?<ap>a\.?m\.?|p\.?m\.?)|\b(?:at\s+|by\s+)?(?<h24>[01]?\d|2[0-3]):(?<m24>[0-5]\d)\b|\b(?<noon>noon|midnight)\b/i;

/**
 * Deadline SUGGESTIONS from a document's text: only sentences that say "due", "deadline",
 * "submit by"... and contain a date. Nothing is invented: no date in the text, no date out.
 * A missing year means the next such date on or after `now` minus 30 days.
 */
export function extractDeadlines (text: string, doc: { title: string; id: string }, now: Date, tz: string, max = 5): DeadlineSuggestion[]
{
    const out: DeadlineSuggestion[] = [];
    const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+|\s+(?=\d+\.\s)|\s*[•▪]\s*/);
    const today = wallClock(now, tz);
    for (const sentence of sentences)
    {
        if (out.length >= max) break;
        if (!DUE_WORDS.test(sentence)) continue;
        const d = DATE.exec(sentence)?.groups;
        const snippet = sentence.trim().slice(0, 200);
        if (!d) continue;
        let year = Number(d.iy ?? d.uy ?? d.ny ?? 0);
        const month = d.iso ? Number(d.im) : d.us ? Number(d.um) : MONTHS.indexOf(d.nm.slice(0, 3).toLowerCase()) + 1;
        const day = Number(d.id ?? d.ud ?? d.nd);
        if (year > 0 && year < 100) year += 2000;
        if (!year)
        {
            year = today.year;
            const probe = Date.UTC(year, month - 1, day);
            if (probe < Date.UTC(today.year, today.month - 1, today.day) - 30 * 86_400_000) year += 1;
        }
        const t = TIME.exec(sentence.slice(sentence.search(DATE)))?.groups;
        let hour = 23;
        let minute = 59;
        let hasTime = false;
        if (t?.noon) { hour = t.noon.toLowerCase() === 'noon' ? 12 : 23; minute = t.noon.toLowerCase() === 'noon' ? 0 : 59; hasTime = true; }
        else if (t?.h)
        {
            hour = Number(t.h) % 12 + (/p/i.test(t.ap) ? 12 : 0);
            minute = Number(t.mi ?? 0);
            hasTime = Number(t.h) >= 1 && Number(t.h) <= 12;
        }
        else if (t?.h24) { hour = Number(t.h24); minute = Number(t.m24); hasTime = true; }
        const due = parseLocalDue(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${hour}:${String(minute).padStart(2, '0')}`, tz);
        out.push({ snippet, dueAt: due ? due.toISOString() : null, hasTime: hasTime && Boolean(due), documentTitle: doc.title, documentId: doc.id });
    }
    return out;
}

// ------------------------------------------------------------------ what the tutor may change

export interface AssignmentRow
{
    id: string;
    title: string;
    description: string;
    due_at: string | null;
    due_timezone: string | null;
    due_status: 'none' | 'suggested' | 'confirmed';
    status: 'todo' | 'in_progress' | 'done';
    estimated_minutes: number | null;
}

export interface AssignmentRequest
{
    title?: string;
    description?: string;
    /** "YYYY-MM-DD HH:MM" or "YYYY-MM-DD" in the student's timezone. */
    dueLocal?: string;
    /** The student said yes to exactly this due date in this conversation. */
    studentConfirmedDue: boolean;
    status?: AssignmentRow['status'];
    estimatedMinutes?: number;
}

export type AssignmentChange = { ok: true; fields: Partial<AssignmentRow> } | { ok: false; error: string };

/**
 * The tutor's write rules: a due date it sets is only a SUGGESTION unless the student confirmed
 * it; a CONFIRMED due date is never changed without the student's confirmation; titles and
 * descriptions of existing work are left to the student; status may follow what the student says.
 */
export function assignmentChange (existing: AssignmentRow | null, request: AssignmentRequest, tz: string): AssignmentChange
{
    const fields: Partial<AssignmentRow> = {};
    if (!existing)
    {
        const title = (request.title ?? '').trim().slice(0, 160);
        if (!title) return { ok: false, error: 'A new assignment needs a title.' };
        fields.title = title;
        fields.description = (request.description ?? '').trim().slice(0, 2000);
    }
    if (request.dueLocal !== undefined)
    {
        const due = parseLocalDue(request.dueLocal, tz);
        if (!due) return { ok: false, error: 'due must be "YYYY-MM-DD" or "YYYY-MM-DD HH:MM" (24 h) in the student\'s timezone.' };
        if (existing?.due_status === 'confirmed' && !request.studentConfirmedDue)
        {
            return { ok: false, error: 'This due date was confirmed by the student. Ask them before changing it, then call again with student_confirmed_due=true.' };
        }
        fields.due_at = due.toISOString();
        fields.due_timezone = tz;
        fields.due_status = request.studentConfirmedDue ? 'confirmed' : 'suggested';
    }
    else if (request.studentConfirmedDue && existing?.due_status === 'suggested')
    {
        fields.due_status = 'confirmed'; // "yes, that date is right"
    }
    if (request.status) fields.status = request.status;
    if (request.estimatedMinutes !== undefined)
    {
        if (!Number.isInteger(request.estimatedMinutes) || request.estimatedMinutes < 5 || request.estimatedMinutes > 6000) return { ok: false, error: 'estimated_minutes must be 5-6000.' };
        fields.estimated_minutes = request.estimatedMinutes;
    }
    if (!Object.keys(fields).length) return { ok: false, error: 'Nothing to change.' };
    return { ok: true, fields };
}

// ------------------------------------------------------------------ study plan

export interface PlanInput
{
    assignments: { id: string; title: string; dueAt: string | null; dueStatus: string; status: string; estimatedMinutes: number | null }[];
    needsPractice: string[];
    now: Date;
    tz: string;
    /** Study minutes per day the student wants (default 60). */
    dailyMinutes?: number;
    /** Local hour the day's study starts (default 17 = 5 PM). */
    startHour?: number;
    days?: number;
}

export interface PlannedSession { title: string; assignmentId: string | null; startsAt: string; startsLocal: string; minutes: number; reason: string }

/**
 * A proposal the student approves before anything is saved: earliest deadline first, each
 * unfinished assignment's estimate (default 60 min) spread over the days before it is due, at most
 * `dailyMinutes` per day, sessions of 25-50 min; leftover time reviews topics needing practice.
 * Suggested (unconfirmed) due dates are planned too but labelled as unconfirmed.
 */
export function planStudy (input: PlanInput): { sessions: PlannedSession[]; warnings: string[] }
{
    const { now, tz } = input;
    const daily = Math.min(240, Math.max(15, input.dailyMinutes ?? 60));
    const days = Math.min(21, Math.max(1, input.days ?? 7));
    const startHour = Math.min(22, Math.max(6, input.startHour ?? 17));
    const used = new Array<number>(days).fill(0);
    const sessions: PlannedSession[] = [];
    const warnings: string[] = [];
    const today = wallClock(now, tz);
    const dayStart = (offset: number) =>
    {
        const date = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
        return zonedToUtc({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: startHour, minute: 0 }, tz);
    };
    const place = (offset: number, minutes: number, title: string, assignmentId: string | null, reason: string) =>
    {
        let start = new Date(dayStart(offset).getTime() + used[offset] * 60_000);
        if (offset === 0 && start.getTime() < now.getTime() + 15 * 60_000)
        {
            // Today: start soon (next quarter hour) if the usual time has passed.
            const soon = Math.ceil((now.getTime() + 15 * 60_000) / 900_000) * 900_000;
            start = new Date(soon + used[offset] * 60_000);
            if (wallClock(start, tz).hour >= 22) return false;
        }
        sessions.push({ title, assignmentId, startsAt: start.toISOString(), startsLocal: formatLocal(start, tz), minutes, reason });
        used[offset] += minutes + 10; // short break between sessions
        return true;
    };

    const open = input.assignments.filter((a) => a.status !== 'done' && a.dueAt)
        .sort((a, b) => new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime());
    for (const a of open)
    {
        const due = new Date(a.dueAt!);
        if (due.getTime() <= now.getTime()) { warnings.push(`${a.title} is already overdue.`); continue; }
        const lastDay = Math.min(days - 1, daysUntil(due, now, tz) - (wallClock(due, tz).hour < startHour + 1 ? 1 : 0));
        let remaining = a.estimatedMinutes ?? 60;
        const label = a.dueStatus === 'confirmed' ? dueLabel(due, now, tz) : `${dueLabel(due, now, tz)}, date not confirmed yet`;
        for (let offset = 0; offset <= Math.max(0, lastDay) && remaining > 0; offset++)
        {
            const free = daily - used[offset];
            if (free < 15) continue;
            const minutes = Math.min(remaining, free, 50);
            if (place(offset, minutes, `Work on ${a.title}`, a.id, label)) remaining -= minutes;
        }
        if (remaining > 0) warnings.push(`Not enough study time before ${a.title} is ${dueLabel(due, now, tz)}: about ${remaining} more minutes needed.`);
    }
    if (!open.length && !input.assignments.some((a) => a.status !== 'done')) warnings.push('No dated assignments yet: add due dates to plan around them.');
    for (const topic of input.needsPractice.slice(0, 3))
    {
        const offset = used.findIndex((u) => daily - u >= 25);
        if (offset < 0) break;
        place(offset, 25, `Practise ${topic}`, null, 'marked as needing practice');
    }
    sessions.sort((x, y) => x.startsAt.localeCompare(y.startsAt));
    return { sessions, warnings };
}
