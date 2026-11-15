// EDUROAM start-up: Open -> Sign In / Create Account -> load the saved player -> enter the village.
//
// The Phaser game is NOT created until Supabase confirms a real (non-guest) session (getUser), so no
// village appears behind the login screen and no game key can fire. Order once signed in:
//   1. the verified Supabase user id becomes the storage scope of every progress store (crystals,
//      inventory, tower, dungeon, local chat history are per account: data/storage.ts);
//   2. a game saved in this browser without an account is offered, never copied silently;
//   3. the game modules load and start; the NPC manager loads that account's NPCs + classes from
//      Supabase (tombstones applied, nothing inserted for existing NPCs) and restores the village;
//   4. the gate is removed and game keys are released.
// Signing out (here, or in another tab) closes any call, stops input and reloads the page: no
// account data survives in memory, local saves are kept, and the gate is back.

import type { Game } from 'phaser';
import type { Session } from '@supabase/supabase-js';
import { getAccountScope, setAccountScope } from './data/storage';
import { setInputLock } from './input/inputGuard';
import {
    backendConfigured, inPasswordRecovery, initBackend, onPasswordRecovery, onProfileChange, onSessionChange, pendingUpgrade, verifiedSession,
} from './services/backend';
import { adoptDeviceSave, declineDeviceSave, shouldOfferDeviceSave } from './services/deviceSave';
import { AuthGate } from './ui/AuthGate';

const GATE_LOCK = 'auth-gate';

export interface AppOptions
{
    /** How "start from a clean page" happens (tests observe it instead of really reloading). */
    reload?: () => void;
}

export async function startApp (parent = 'game-container', options: AppOptions = {})
{
    const reload = options.reload ?? (() => window.location.reload());
    // Every successful sign-in step in the gate (password, email code, reset code) continues here.
    const gate = new AuthGate(document.body, () => void admit());
    setInputLock(GATE_LOCK, true);
    gate.loading();

    let game: Game | null = null;
    let admitting: Promise<void> | null = null;
    let leaving = false;
    // Auth events before initialisation finished (saved session, email link) are handled by the
    // first admit() below, which runs once supabase-js has finished reading the URL.
    let ready = false;
    /** Shown on the sign-in screen once: why an email link did not sign anyone in. */
    let linkNotice = '';

    const enter = async (session: Session) =>
    {
        const id = session.user.id;
        if (game)
        {
            // Another account than the one this page was built for: start from a clean page.
            if (getAccountScope() !== id) { reload(); return; }
            game.resume();
        }
        else
        {
            setAccountScope(id);
            gate.loading('Loading your village…');
            const { default: StartGame } = await import('./main');
            game = StartGame(parent);
            if (import.meta.env.DEV) (window as unknown as { eduroamGame?: Game }).eduroamGame = game;
        }
        gate.hide();
        setInputLock(GATE_LOCK, false);
        document.querySelector<HTMLElement>(`#${parent} canvas`)?.focus();
    };

    const admit = (): Promise<void> => admitting ??= (async () =>
    {
        try
        {
            const check = await verifiedSession();
            if (!check.session)
            {
                if (check.error && /reach|configured/.test(check.error)) gate.failure(check.error, () => void admit());
                else gate.signIn(check.error ?? linkNotice);
                linkNotice = '';
                return;
            }
            const session = check.session;
            // Signed in by a reset link / code: nothing else until the new password is saved,
            // then the normal path (saved-game offer, village).
            if (inPasswordRecovery(session.user.id)) { gate.newPassword(() => void admit()); return; }
            if (session.user.is_anonymous) { gate.guest(() => void admit()); return; }
            const offer = shouldOfferDeviceSave(session.user.id);
            if (offer)
            {
                const add = await gate.offerDeviceSave(offer, session.user.email ?? 'your account');
                if (add) adoptDeviceSave(session.user.id);
                else declineDeviceSave(session.user.id);
            }
            await enter(session);
        }
        catch (err)
        {
            console.error('[app] sign-in check failed', err);
            gate.failure('Something went wrong while loading your account.', () => void admit());
        }
        finally { admitting = null; }
    })();

    const leave = async () =>
    {
        if (leaving) return;
        leaving = true;
        setInputLock(GATE_LOCK, true);
        game?.pause();
        gate.loading('Signing out…');
        try
        {
            // End an active call first (the agent saves what was studied when the call ends).
            const { getUi } = await import('./ui');
            await getUi().voice.close();
        }
        catch { /* no UI yet */ }
        reload();
    };

    if (!backendConfigured)
    {
        gate.failure('Accounts are not configured for this build (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY in .env.local).', reload);
        return;
    }

    onSessionChange((session) =>
    {
        if (!ready) return;
        if (!session) { if (game) void leave(); else if (!admitting) gate.signIn(); return; }
        if (!game || getAccountScope() !== session.user.id) void admit();
    });
    // A guest that just became a permanent account (email confirmed in this tab or by the link).
    onProfileChange((session) => { if (ready && session && !session.user.is_anonymous && !game && pendingUpgrade()) gate.guestPassword(() => void admit()); });
    onPasswordRecovery(() => { if (ready && !game) void admit(); });

    try { linkNotice = (await initBackend())?.redirectError ?? ''; }
    catch (err) { console.warn('[app] auth initialisation failed', err); }
    ready = true;
    await admit();
}
