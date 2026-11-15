// Optional real-browser regression, using installed Edge and a new temporary profile.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const profile = await mkdtemp(join(tmpdir(), 'eduroam-smoke-'));
const server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'error', server: { port: 0, host: '127.0.0.1' },
    // Pre-bundle (as browserAuth.mjs does) so Vite never re-optimizes and reloads the page mid-test.
    optimizeDeps: { include: ['phaser', '@supabase/supabase-js'] },
});
try
{
    await server.listen();
    const { port } = server.httpServer.address();
    const browser = process.env.EDUROAM_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    const child = spawn(browser, ['--headless', '--no-first-run', '--disable-extensions', '--disable-background-networking',
        '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        `--user-data-dir=${profile}`, '--dump-dom', '--virtual-time-budget=30000', '--timeout=45000',
        `http://127.0.0.1:${port}/tests/browser/smoke.html`], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 55_000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    const report = stdout.match(/<pre id="smoke-result">([\s\S]*?)<\/pre>/)?.[1];
    console.log(report || stderr.slice(-3000) || `Browser exited ${code} without a report`);
    if (!report?.startsWith('PASS:')) process.exitCode = 1;
}
finally { await server.close(); }
