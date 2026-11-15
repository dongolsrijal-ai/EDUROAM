// Renders the real chat panel and NPC editor (in-page fake Supabase, no real project) and saves
// screenshots for visual review: desktop 1280x800 and phone 390x844.
//   node tests/browserScreens.mjs [outDir]
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.VITE_SUPABASE_URL = 'https://stub-project.supabase.co';
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_stub';
const out = resolve(process.argv[2] ?? join(tmpdir(), 'eduroam-screens'));
await mkdir(out, { recursive: true });
const browser = process.env.EDUROAM_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const server = await createServer({ configFile: false, root: realpathSync.native(fileURLToPath(new URL('..', import.meta.url))), logLevel: 'error',
    server: { port: 0, host: '127.0.0.1' }, optimizeDeps: { include: ['phaser', '@supabase/supabase-js'] } });

function run (args, ms)
{
    const child = spawn(browser, ['--headless', '--no-first-run', '--disable-extensions', '--disable-background-networking', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', ...args], { windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    const timer = setTimeout(() => child.kill(), ms);
    return new Promise((done) => child.once('exit', () => { clearTimeout(timer); done(stdout); }));
}

try
{
    await server.listen();
    const { port } = server.httpServer.address();
    const base = `http://127.0.0.1:${port}/tests/browser`;
    const profile = await mkdtemp(join(tmpdir(), 'eduroam-screens-'));
    // Sign in once through the stub (same as the auth test's login phase).
    const login = await run([`--user-data-dir=${profile}`, '--window-size=1280,800', '--dump-dom', '--virtual-time-budget=30000', '--timeout=45000', `${base}/auth.html?phase=login`], 55_000);
    console.log('login:', login.match(/<pre id="auth-result">([\s\S]*?)<\/pre>/)?.[1]);
    for (const view of ['screen-chat', 'screen-npc'])
    {
        const dom = await run([`--user-data-dir=${profile}`, '--window-size=1280,800', '--dump-dom', '--virtual-time-budget=25000', `${base}/auth.html?phase=${view}`], 55_000);
        console.log(`${view}:`, dom.match(/<pre id="auth-result"[^>]*>([\s\S]*?)<\/pre>/)?.[1]);
        await run([`--user-data-dir=${profile}`, '--window-size=1280,800', `--screenshot=${join(out, `${view}-desktop.png`)}`, '--virtual-time-budget=25000', `${base}/auth.html?phase=${view}`], 55_000);
        await run([`--user-data-dir=${profile}`, '--window-size=390,844', `--screenshot=${join(out, `${view}-phone.png`)}`, '--virtual-time-budget=25000', `${base}/screens-phone.html?phase=${view}`], 55_000);
    }
    // The sign-in gate as a signed-out player sees it (fresh profile each: no saved session).
    for (const view of ['screen-gate', 'screen-gate-register', 'screen-gate-code', 'screen-gate-reset'])
    {
        for (const [size, name, page] of [['1280,800', 'desktop', `auth.html?phase=${view}`], ['390,844', 'phone', `screens-phone.html?phase=${view}`]])
        {
            const fresh = await mkdtemp(join(tmpdir(), 'eduroam-screens-gate-'));
            await run([`--user-data-dir=${fresh}`, `--window-size=${size}`, `--screenshot=${join(out, `${view}-${name}.png`)}`, '--virtual-time-budget=15000', `${base}/${page}`], 55_000);
        }
    }
    console.log(`screenshots in ${out}`);
}
finally { await server.close(); }
