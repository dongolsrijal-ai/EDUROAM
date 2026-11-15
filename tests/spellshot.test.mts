// Spellshot client rules: scoring mirrors the server, difficulty ramps, motion helpers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAMES } from '../supabase/functions/_shared/questionPack.ts';
import {
    afterMiss, BASE_SPEED, bandCenters, clock, pointsFor, POINTS, ROUND_MS, speedFor, TARGET_MARKS, targetKey, wrapX,
} from '../src/game/minigames/spellshot/spellshotLogic.ts';
import { SPELLSHOT_CHOICES } from '../supabase/functions/_shared/validation.ts';

test('live scoring matches the server grading rules', () =>
{
    assert.deepEqual(POINTS, GAMES.spellshot.points);
    assert.deepEqual([pointsFor(0), pointsFor(1), pointsFor(5), pointsFor(12)], [100, 120, 200, 200]);
    assert.equal(afterMiss(30), 0);
    assert.equal(afterMiss(300), 260);
});

test('one mark per possible target, 60-second round', () =>
{
    assert.equal(TARGET_MARKS.length, SPELLSHOT_CHOICES.max);
    assert.equal(ROUND_MS, 60_000);
    assert.equal(clock(60_000), '1:00');
    assert.equal(clock(9_001), '0:10');
    assert.equal(clock(0), '0:00');
});

test('wisps speed up with the combo and as the clock runs down', () =>
{
    assert.ok(BASE_SPEED.gentle < BASE_SPEED.brisk && BASE_SPEED.brisk < BASE_SPEED.swift);
    assert.equal(speedFor('brisk', 0, 0), BASE_SPEED.brisk);
    assert.ok(speedFor('brisk', 3, 0) > speedFor('brisk', 0, 0));
    assert.ok(speedFor('brisk', 0, 45_000) > speedFor('brisk', 0, 15_000));
    assert.equal(speedFor('brisk', 50, 999_999), speedFor('brisk', 6, ROUND_MS), 'bounded ramp');
});

test('flight bands, wrap-around and number keys', () =>
{
    assert.deepEqual(bandCenters(40, 140, 4), [52.5, 77.5, 102.5, 127.5]);
    assert.equal(wrapX(50, 300, 20), 50);
    assert.equal(wrapX(321, 300, 20), -19, 'off the right edge re-enters on the left');
    assert.equal(wrapX(-21, 300, 20), 319, 'off the left edge re-enters on the right');
    assert.equal(targetKey('1', 3), 0);
    assert.equal(targetKey('3', 3), 2);
    assert.equal(targetKey('4', 3), null);
    assert.equal(targetKey('a', 5), null);
});
