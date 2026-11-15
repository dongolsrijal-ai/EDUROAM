// Deadlines, timezones and study planning for the AI tutor (supabase/functions/_shared/schedule.ts).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    assignmentChange, daysUntil, dueLabel, extractDeadlines, parseLocalDue, planStudy, validTimeZone, wallClock, zonedToUtc, type AssignmentRow,
} from '../supabase/functions/_shared/schedule.ts';

const NY = 'America/New_York';
const doc = { title: 'Syllabus.pdf', id: 'doc-1' };

test('timezones: only real IANA names', () =>
{
    assert.equal(validTimeZone('America/New_York'), 'America/New_York');
    assert.equal(validTimeZone('Asia/Kolkata'), 'Asia/Kolkata');
    assert.equal(validTimeZone('Mars/Olympus'), null);
    assert.equal(validTimeZone('../../etc'), null);
    assert.equal(validTimeZone(42), null);
});

test('daylight saving: wall-clock times convert correctly on both sides of each switch', () =>
{
    // EST (UTC-5) vs EDT (UTC-4).
    assert.equal(zonedToUtc({ year: 2026, month: 3, day: 7, hour: 23, minute: 59 }, NY).toISOString(), '2026-03-08T04:59:00.000Z');
    assert.equal(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 23, minute: 59 }, NY).toISOString(), '2026-03-09T03:59:00.000Z');
    // 02:30 on 8 March 2026 does not exist in New York: it moves forward to 03:30 EDT.
    assert.equal(zonedToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY).toISOString(), '2026-03-08T07:30:00.000Z');
    // 01:30 on 1 November 2026 happens twice: the first (EDT) is used.
    assert.equal(zonedToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY).toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(zonedToUtc({ year: 2026, month: 11, day: 2, hour: 9, minute: 0 }, NY).toISOString(), '2026-11-02T14:00:00.000Z');
    // Half-hour zones and the date line.
    assert.equal(zonedToUtc({ year: 2026, month: 11, day: 19, hour: 9, minute: 0 }, 'Asia/Kolkata').toISOString(), '2026-11-19T03:30:00.000Z');
    const w = wallClock(new Date('2026-11-19T11:00:00Z'), 'Pacific/Auckland');
    assert.deepEqual([w.day, w.hour], [20, 0]);
});

test('"due tomorrow" is counted in the student\'s own calendar days', () =>
{
    const now = new Date('2026-11-19T03:00:00Z'); // 10 PM on the 18th in New York, already the 19th in UTC
    const due = parseLocalDue('2026-11-19 23:59', NY)!;
    assert.equal(due.toISOString(), '2026-11-20T04:59:00.000Z');
    assert.equal(daysUntil(due, now, NY), 1);
    assert.match(dueLabel(due, now, NY), /^due tomorrow at 11:59 PM$/);
    assert.equal(daysUntil(due, now, 'UTC'), 1);
    assert.equal(dueLabel(new Date('2026-11-18T00:00:00Z'), now, NY), 'overdue');
    assert.equal(parseLocalDue('2026-02-30', NY), null, 'not a real date');
    assert.equal(parseLocalDue('next friday', NY), null, 'no guessing');
    assert.equal(parseLocalDue('2026-11-19', NY)!.toISOString(), '2026-11-20T04:59:00.000Z', 'date only = end of that day');
});

test('deadlines in uploaded files become suggestions; no date in the text means no date', () =>
{
    const now = new Date('2026-11-15T15:00:00Z');
    const text = 'Welcome to Biology. Lab report 3 is due Nov 19 at 11:59 pm. Read chapter 4 before class. '
        + 'Final project deadline: December 5, 2026 by 5pm. Homework 2 due 11/21. The quiz is due soon. '
        + 'Midterm review sheet due 2027-01-08 23:00.';
    const found = extractDeadlines(text, doc, now, NY);
    assert.deepEqual(found.map((f) => f.dueAt), ['2026-11-20T04:59:00.000Z', '2026-12-05T22:00:00.000Z', '2026-11-22T04:59:00.000Z', '2027-01-09T04:00:00.000Z']);
    assert.deepEqual(found.map((f) => f.hasTime), [true, true, false, true], 'a missing time is flagged for confirmation');
    assert.ok(found.every((f) => f.documentTitle === 'Syllabus.pdf' && f.snippet.length <= 200));
    assert.ok(!found.some((f) => /due soon/.test(f.snippet)), '"due soon" has no date: nothing invented');
    assert.equal(extractDeadlines('Chapter 4 covers mitosis on Nov 19.', doc, now, NY).length, 0, 'a date without "due" is not a deadline');
    // Year rollover: in December, "Jan 10" means next January.
    assert.equal(extractDeadlines('Essay due Jan 10.', doc, new Date('2026-12-20T12:00:00Z'), NY)[0].dueAt, '2027-01-11T04:59:00.000Z');
});

const existing = (over: Partial<AssignmentRow> = {}): AssignmentRow => ({ id: 'a1', title: 'Lab report', description: '', due_at: '2026-11-20T04:59:00.000Z', due_timezone: NY, due_status: 'confirmed', status: 'todo', estimated_minutes: null, ...over });

test('the tutor suggests due dates; only the student confirms them, and confirmed dates are protected', () =>
{
    const suggested = assignmentChange(null, { title: 'Essay', dueLocal: '2026-11-21', studentConfirmedDue: false }, NY);
    assert.ok(suggested.ok && suggested.fields.due_status === 'suggested' && suggested.fields.due_at === '2026-11-22T04:59:00.000Z');
    const confirmed = assignmentChange(null, { title: 'Essay', dueLocal: '2026-11-21 17:00', studentConfirmedDue: true }, NY);
    assert.ok(confirmed.ok && confirmed.fields.due_status === 'confirmed' && confirmed.fields.due_timezone === NY);

    const change = assignmentChange(existing(), { dueLocal: '2026-11-25', studentConfirmedDue: false }, NY);
    assert.ok(!change.ok && /confirmed by the student/.test(change.error), 'no silent change of a confirmed date');
    assert.ok(assignmentChange(existing(), { dueLocal: '2026-11-25', studentConfirmedDue: true }, NY).ok);
    const yes = assignmentChange(existing({ due_status: 'suggested' }), { studentConfirmedDue: true }, NY);
    assert.ok(yes.ok && yes.fields.due_status === 'confirmed' && !('due_at' in yes.fields), 'confirming keeps the suggested date');
    const done = assignmentChange(existing(), { status: 'done', studentConfirmedDue: false }, NY);
    assert.ok(done.ok && done.fields.status === 'done' && !('title' in done.fields), 'status only; the title stays the student\'s');
    assert.ok(!assignmentChange(null, { studentConfirmedDue: false }, NY).ok, 'new work needs a title');
    assert.ok(!assignmentChange(existing(), { dueLocal: 'tomorrow-ish', studentConfirmedDue: true }, NY).ok);
    assert.ok(!assignmentChange(existing(), { estimatedMinutes: 2, studentConfirmedDue: false }, NY).ok);
});

test('study plan: earliest deadline first, within the daily budget, before each due date', () =>
{
    const now = new Date('2026-11-17T14:00:00Z'); // 9 AM in New York
    const { sessions, warnings } = planStudy({
        now, tz: NY, dailyMinutes: 60,
        assignments: [
            { id: 'late', title: 'Essay', dueAt: '2026-11-22T04:59:00Z', dueStatus: 'suggested', status: 'todo', estimatedMinutes: 90 },
            { id: 'soon', title: 'Lab report', dueAt: '2026-11-19T04:59:00Z', dueStatus: 'confirmed', status: 'todo', estimatedMinutes: 150 },
            { id: 'done', title: 'Old quiz', dueAt: '2026-11-18T04:59:00Z', dueStatus: 'confirmed', status: 'done', estimatedMinutes: 60 },
        ],
        needsPractice: ['photosynthesis'],
    });
    assert.ok(sessions.every((s) => s.minutes <= 50 && s.minutes >= 15), 'sessions of 15-50 minutes');
    assert.ok(!sessions.some((s) => s.assignmentId === 'done'), 'finished work is not planned');
    const lab = sessions.filter((s) => s.assignmentId === 'soon');
    assert.ok(lab.length && lab.every((s) => new Date(s.startsAt) < new Date('2026-11-19T04:59:00Z')), 'lab sessions before it is due');
    assert.ok(new Date(lab[0].startsAt) <= new Date(sessions.find((s) => s.assignmentId === 'late')!.startsAt), 'earliest deadline first');
    assert.ok(sessions.some((s) => s.assignmentId === 'late' && /not confirmed/.test(s.reason)), 'unconfirmed dates are labelled');
    const perDay = new Map<string, number>();
    for (const s of sessions) { const d = wallClock(new Date(s.startsAt), NY).day; perDay.set(String(d), (perDay.get(String(d)) ?? 0) + s.minutes); }
    assert.ok([...perDay.values()].every((m) => m <= 60), `daily budget kept: ${JSON.stringify([...perDay])}`);
    assert.ok(sessions.every((s) => wallClock(new Date(s.startsAt), NY).hour >= 17 && wallClock(new Date(s.startsAt), NY).hour < 22), 'evening study window');
    assert.ok(warnings.some((w) => /Lab report/.test(w)), 'too little time before the lab report is reported');
    assert.ok(sessions.some((s) => /photosynthesis/.test(s.title)) || warnings.length, 'practice topic used if time remains');
    assert.deepEqual(planStudy({ now, tz: NY, assignments: [], needsPractice: [] }).warnings, ['No dated assignments yet: add due dates to plan around them.']);
});
