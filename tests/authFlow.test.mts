// Email one-time-code helpers: validation, cooldown, error messages and redirect detection.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    cooldownRemaining, describeAuthError, describeCodeError, describePasswordError, describeRedirectError, formatWait, frequencyWaitSeconds, isEmailQuotaError, isNoAccountForCode, isValidEmail, isValidOtp, MIN_PASSWORD, normalizeOtp, OTP_RESEND_SECONDS, parseRetryAfter, passwordProblem, readAuthCallback,
} from '../src/game/services/authFlow.ts';

test('emails and codes are validated before any request is sent', () =>
{
    assert.ok(isValidEmail(' Student@School.org '));
    assert.ok(!isValidEmail('student@school'));
    assert.ok(!isValidEmail(''));
    assert.equal(normalizeOtp(' 123 456 '), '123456');
    assert.equal(normalizeOtp('123-456'), '123456');
    assert.ok(isValidOtp('123 456'));
    assert.ok(isValidOtp('12345678'), 'longer codes are allowed when configured in Supabase');
    assert.ok(!isValidOtp('12345'));
    assert.ok(!isValidOtp('12a456'));
});

test('resend cooldown counts down from the last request', () =>
{
    const sentAt = 1_000_000;
    assert.equal(cooldownRemaining(sentAt, sentAt), OTP_RESEND_SECONDS);
    assert.equal(cooldownRemaining(sentAt, sentAt + 59_001), 1);
    assert.equal(cooldownRemaining(sentAt, sentAt + 60_000), 0);
    assert.equal(cooldownRemaining(sentAt, sentAt + 3_600_000), 0);
});

test('rate limits, wrong/expired codes and SMTP limits get clear messages', () =>
{
    const quota = describeAuthError({ status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }, 'send');
    assert.match(quota, /No code was sent/);
    assert.match(quota, /hourly sign-in email limit/);
    assert.doesNotMatch(quota, /60|minute|a few seconds/, 'never suggests a short wait fixes the hourly quota');
    assert.match(describeAuthError({ status: 429, message: 'email rate limit exceeded' }, 'send', 1200), /Try again in about 20 min/);
    assert.match(describeAuthError({ status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' }, 'send'), /too many requests from this device/);
    assert.match(describeAuthError({ status: 429, message: 'Request rate limit reached' }, 'verify'), /Too many attempts/);
    assert.match(describeAuthError({ status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' }, 'verify'), /wrong or has expired/);
    assert.match(describeAuthError({ status: 400, code: 'email_address_not_authorized', message: 'Email address not authorized' }, 'send'), /custom email \(SMTP\)/);
    assert.match(describeAuthError({ status: 0, message: 'Failed to fetch' }, 'send'), /Could not reach/);
    assert.equal(describeAuthError({ message: 'Something odd' }, 'send'), 'Something odd');
    // A send failure is never reported as success-like text.
    assert.doesNotMatch(describeAuthError({ status: 500, message: 'Error sending magic link email' }, 'send'), /sent a sign-in code/);
});

test('auth redirects are detected and stripped; normal game URLs are untouched', () =>
{
    const implicit = readAuthCallback('https://eduroam.example/play/#access_token=abc&refresh_token=def&expires_in=3600&type=magiclink');
    assert.equal(implicit.present, true);
    assert.equal(implicit.cleanUrl, 'https://eduroam.example/play/');

    const pkce = readAuthCallback('http://localhost:8080/?code=0b5e1f3a-7c2d-4e8f-9a1b-2c3d4e5f6a7b&level=2');
    assert.equal(pkce.present, true);
    assert.equal(pkce.cleanUrl, 'http://localhost:8080/?level=2');

    const failed = readAuthCallback('https://eduroam.example/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    assert.equal(failed.present, true);
    assert.equal(failed.error, 'Email link is invalid or has expired');

    const plain = readAuthCallback('https://eduroam.example/?code=abc#section');
    assert.equal(plain.present, false, 'a short non-auth ?code= is not treated as an auth redirect');
    assert.equal(plain.cleanUrl, 'https://eduroam.example/?code=abc#section');
});

test('Retry-After headers are honoured in seconds or HTTP-date form', () =>
{
    const now = Date.parse('2026-11-14T12:00:00Z');
    assert.equal(parseRetryAfter('120', now), 120);
    assert.equal(parseRetryAfter('Sat, 14 Nov 2026 12:30:00 GMT', now), 1800);
    assert.equal(parseRetryAfter(null, now), null);
    assert.equal(parseRetryAfter('soon', now), null);
    assert.equal(formatWait(45), '45s');
    assert.equal(formatWait(1800), '30 min');
    assert.equal(formatWait(7200), '2 h');
});

test('passwords are checked before sign-up / password change requests', () =>
{
    assert.match(passwordProblem('short') ?? '', new RegExp(`at least ${MIN_PASSWORD}`));
    assert.match(passwordProblem(' padded pass ') ?? '', /start or end with a space/);
    assert.match(passwordProblem('correct horse', 'correct house') ?? '', /do not match/);
    assert.equal(passwordProblem('correct horse', 'correct horse'), null);
    assert.match(passwordProblem('x'.repeat(73)) ?? '', /at most 72/);
});

test('password sign-in / sign-up / upgrade errors are explained to the player', () =>
{
    assert.match(describePasswordError({ status: 400, code: 'invalid_credentials', message: 'Invalid login credentials' }, 'signin'), /Wrong email or password/);
    assert.match(describePasswordError({ code: 'email_not_confirmed', message: 'Email not confirmed' }, 'signin'), /Confirm your email first/);
    assert.match(describePasswordError({ code: 'email_exists', message: 'A user with this email address has already been registered' }, 'upgrade'), /guest NPCs stay with the guest account/);
    assert.match(describePasswordError({ code: 'user_already_exists', message: 'User already registered' }, 'signup'), /Sign in instead/);
    assert.match(describePasswordError({ code: 'weak_password', message: 'Password should be at least 8 characters.' }, 'signup'), /at least 8/);
    assert.match(describePasswordError({ code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }, 'upgrade'), /hourly email limit/);
});

test('a sign-in code for an unknown address is answered like a sent one (no account is created or revealed)', () =>
{
    assert.equal(isNoAccountForCode({ status: 422, code: 'otp_disabled', message: 'Signups not allowed for otp' }), true);
    assert.equal(isNoAccountForCode({ status: 422, message: 'Signups not allowed for otp' }), true);
    assert.equal(isNoAccountForCode({ status: 429, code: 'over_email_send_rate_limit', message: 'email rate limit exceeded' }), false);
});

test('the per-address resend limit is a short wait, not the hourly quota; SMTP failures say so', () =>
{
    const frequency = { status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 42 seconds.' };
    assert.equal(frequencyWaitSeconds(frequency), 42);
    assert.equal(isEmailQuotaError(frequency), false);
    assert.match(describeAuthError(frequency, 'send'), /wait 42s/);
    assert.match(describePasswordError(frequency, 'password'), /wait 42s/);
    assert.equal(isEmailQuotaError({ status: 429, code: 'over_email_send_rate_limit', message: 'Email rate limit exceeded' }), true);
    assert.match(describeAuthError({ status: 500, message: 'Error sending recovery email' }, 'send'), /could not be sent/);
});

test('a rejected code is called expired only when it is older than the code lifetime', () =>
{
    const rejected = { status: 403, code: 'otp_expired', message: 'Token has expired or is invalid' };
    const now = 10_000_000_000;
    assert.match(describeCodeError(rejected, now - 2 * 3600_000, now), /That code has expired/);
    assert.match(describeCodeError(rejected, now - 60_000, now), /wrong or has expired/);
    assert.match(describeCodeError(rejected, null, now), /wrong or has expired/);
    assert.match(describeCodeError({ status: 429, message: 'Too many requests' }, now - 2 * 3600_000, now), /Too many attempts/);
});

test('reset links: type and token are read (not logged), used / expired links are explained', () =>
{
    const link = readAuthCallback('http://localhost:8081/#access_token=aaa.bbb.ccc&expires_in=3600&refresh_token=r&token_type=bearer&type=recovery');
    assert.equal(link.type, 'recovery');
    assert.equal(link.accessToken, 'aaa.bbb.ccc');
    assert.equal(link.cleanUrl, 'http://localhost:8081/');
    assert.equal(describeRedirectError(link), null);

    const used = readAuthCallback('http://localhost:8081/?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    assert.equal(used.present, true);
    assert.equal(used.errorCode, 'otp_expired');
    assert.equal(used.cleanUrl, 'http://localhost:8081/');
    assert.match(describeRedirectError(used)!, /expired or was already used/);
    assert.match(describeRedirectError({ error: 'Something else', errorCode: 'bad_oauth_state' })!, /did not work: Something else/);
    assert.equal(readAuthCallback('http://localhost:8081/?type=recovery').type, null, 'a bare ?type= is not an auth redirect');
});
