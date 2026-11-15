// Real-browser test of the email-code sign-in against an in-page fake Supabase API
// (tests/browser/authStub.ts): no email is sent and no real project is contacted.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fake project: overrides any .env.local values for this test only.
process.env.VITE_SUPABASE_URL = 'https://stub-project.supabase.co';
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_stub';

const browser = process.env.EDUROAM_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const server = await createServer({ configFile: false, // Canonical path: a drive-letter case mismatch makes Vite serve one module under two URLs.
    root: realpathSync.native(fileURLToPath(new URL('..', import.meta.url))), logLevel: 'error', server: { port: 0, host: '127.0.0.1' },
    // Pre-bundle so Vite never reloads the page mid-test after discovering a dependency.
    optimizeDeps: { include: ['phaser', '@supabase/supabase-js'] } });

// What Supabase appends to the redirect when an email link was already used or has expired.
const EXPIRED = 'error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';

// Optional: EDUROAM_PHASES=gate-code,accounts runs only those phases (the others count as passed).
const only = process.env.EDUROAM_PHASES?.split(',').map((p) => p.trim()).filter(Boolean);

async function run (phase, profile, size, page = `auth.html?phase=${phase}`)
{
    if (only && !only.includes(phase)) return true;
    const { port } = server.httpServer.address();
    const child = spawn(browser, ['--headless', '--no-first-run', '--disable-extensions', '--disable-background-networking',
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', `--user-data-dir=${profile}`, `--window-size=${size}`,
        '--dump-dom', `--virtual-time-budget=${phase === 'dash' ? 90000 : 30000}`, `--timeout=${phase === 'dash' ? 110000 : 45000}`, `http://127.0.0.1:${port}/tests/browser/${page}`], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => child.kill(), phase === 'dash' ? 130_000 : 55_000);
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    const report = stdout.match(/<pre id="auth-result">([\s\S]*?)<\/pre>/)?.[1] ?? 'no report';
    console.log(`${phase}: ${report}`);
    return report.startsWith('PASS');
}

try
{
    await server.listen();
    const desktop = await mkdtemp(join(tmpdir(), 'eduroam-auth-'));
    const phone = await mkdtemp(join(tmpdir(), 'eduroam-auth-phone-'));
    const deleteAll = await mkdtemp(join(tmpdir(), 'eduroam-auth-delete-all-'));
    const accounts = await mkdtemp(join(tmpdir(), 'eduroam-auth-accounts-'));
    const gate = await mkdtemp(join(tmpdir(), 'eduroam-auth-gate-'));
    const gatePhone = await mkdtemp(join(tmpdir(), 'eduroam-auth-gate-phone-'));
    const ok = [
        await run('login', desktop, '1280,800'),
        await run('dash', desktop, '1280,800'), // signed in from the login phase
        await run('npc-delete', desktop, '1280,800'),
        await run('reload', desktop, '1280,800'), // same profile = page reload with saved session
        await run('limit', phone, '1280,900', 'phone.html'), // 390x844 iframe
        // Own signed-in profile: Delete All empties the roster the phases above rely on.
        await run('login', deleteAll, '1280,800'),
        await run('npc-delete-all', deleteAll, '1280,800'),
        // Accounts: register, password sign-in, logout, switching, guest upgrade, refresh, another browser.
        await run('accounts', accounts, '1280,800'),
        await run('accounts-reload', accounts, '1280,800'),
        await run('accounts-guest', accounts, '1280,800'),
        await run('accounts-other-browser', accounts, '1280,800'),
        // Sign-in gate through the real start-up: login first, keyboard isolation, refresh, sign out, switching.
        await run('gate', gate, '1280,800'),
        await run('gate-reload', gate, '1280,800'),
        await run('gate-switch', gate, '1280,800'),
        await run('gate-back', gate, '1280,800'),
        await run('gate-return', gate, '1280,800'),
        await run('gate', gatePhone, '1280,900', 'phone.html?phase=gate'), // 390x844
        // Email codes + password reset (mocked Supabase: no real email is sent).
        await run('gate-code', await mkdtemp(join(tmpdir(), 'eduroam-auth-code-')), '1280,800'),
        ...await (async (profile) => [
            await run('gate-reset', profile, '1280,800'),
            await run('gate-reset-reload', profile, '1280,800'),
            await run('gate-reset-login', profile, '1280,800'),
        ])(await mkdtemp(join(tmpdir(), 'eduroam-auth-reset-'))),
        await run('gate-link', await mkdtemp(join(tmpdir(), 'eduroam-auth-link-')), '1280,800'),
        await run('gate-link-expired', await mkdtemp(join(tmpdir(), 'eduroam-auth-expired-')), '1280,800',
            `auth.html?phase=gate-link-expired&${EXPIRED}#${EXPIRED}`),
    ];
    if (!ok.every(Boolean)) process.exitCode = 1;
}
finally { await server.close(); }
