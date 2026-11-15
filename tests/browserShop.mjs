// Real-browser test of the crystal shop, using installed Edge and a new temporary profile.
//   npm run test:browser:shop
//   SHOT_OUT=C:\path\shop.png [SHOT=1|manor|panel] node tests/browserShop.mjs   -> screenshot instead
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const profile = await mkdtemp(join(tmpdir(), 'eduroam-shop-'));
// Canonical path: a drive-letter case mismatch makes Vite serve one module under two URLs
// (two copies of the game state: the test would never see the running scene).
const server = await createServer({ configFile: false, root: realpathSync.native(fileURLToPath(new URL('..', import.meta.url))),
    logLevel: 'error', server: { port: 0, host: '127.0.0.1' }, optimizeDeps: { include: ['phaser', '@supabase/supabase-js'] },
});
try
{
    await server.listen();
    const { port } = server.httpServer.address();
    const browser = process.env.EDUROAM_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
    const shot = process.env.SHOT_OUT;
    const url = `http://127.0.0.1:${port}/tests/browser/shop.html${shot || process.env.SHOT ? `?shot=${process.env.SHOT || 1}` : ''}`;
    const child = spawn(browser, ['--headless', '--no-first-run', '--disable-extensions', '--disable-background-networking',
        '--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,800',
        `--user-data-dir=${profile}`, shot ? `--screenshot=${shot}` : '--dump-dom', '--virtual-time-budget=40000', '--timeout=120000', url], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 240_000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    clearTimeout(timer);
    if (shot) console.log(`screenshot: ${shot}`);
    else
    {
        const report = stdout.match(/<pre id="smoke-result">([\s\S]*?)<\/pre>/)?.[1];
        console.log(report || stderr.slice(-3000) || `Browser exited ${code} without a report`);
        if (!report?.startsWith('PASS:')) process.exitCode = 1;
    }
}
finally { await server.close(); }
