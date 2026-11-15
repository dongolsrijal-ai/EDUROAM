// FaceTime Tutor: talk to one NPC teacher with the single "eduroam-tutor" LiveKit agent.
//
//   Call in game     the server authorises the student, creates a single-use pairing and dispatches
//                    the agent; this panel joins that room with the short-lived token it gets back,
//                    publishes the microphone (and the camera, if turned on: Gemini sees worksheets).
//   Call on FaceTime the shared Chert line: the server returns a single-use 6-digit code and the line's
//                    real address (from its configuration). The student calls the line and says the
//                    code; the agent knows nothing private until then.
//
// Starting a call never creates or changes an NPC: it only looks up the existing one.
// livekit-client is loaded only when an in-game call starts.

import type { LocalVideoTrack, Room } from 'livekit-client';
import type { NpcRecord } from '../data/npcStore';
import { getSession } from '../services/backend';
import { findRemoteNpc, startFaceTimeCall, startVoiceCall, TutorApiError, type RemoteNpc } from '../services/tutorApi';
import { el, gameButton, keyHints, type Modal } from './dom';
import { iconButton } from './uploads';

const errorText = (err: unknown) =>
{
    const name = (err as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone or camera access was blocked. Allow it in your browser, then try again.';
    if (name === 'NotFoundError') return 'No microphone or camera was found.';
    return err instanceof Error ? err.message : 'The call could not be started.';
};

/** How long the student waits for the tutor to join a room before the call is called off. */
const AGENT_JOIN_TIMEOUT_MS = 30_000;

const clock = (ms: number) =>
{
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

type Phase = 'choose' | 'connecting' | 'in-call' | 'facetime' | 'ended';

export class VoicePanel implements Modal
{
    private root: HTMLElement;
    private portrait = el('img', 'portrait');
    private nameEl = el('span', 'dialogue__name');
    private timerEl = el('span', 'voice__timer');
    private statusEl = el('p', 'voice__status');
    private chooseEl: HTMLElement;
    private facetimeEl = el('div', 'voice__facetime hidden');
    private actionsEl: HTMLElement;
    private preview = el('video', 'voice__preview hidden');
    private muteButton: HTMLButtonElement;
    private cameraButton: HTMLButtonElement;
    private audio = el('div', 'visually-hidden');
    private room: Room | null = null;
    private camera: LocalVideoTrack | null = null;
    private record: NpcRecord | null = null;
    private muted = false;
    private startedAt = 0;
    private ticker: ReturnType<typeof setInterval> | null = null;
    /** Increments on every open / close / new call so late results for an old call are dropped. */
    private generation = 0;
    private onClose: (() => void) | null = null;

    constructor (parent: HTMLElement)
    {
        this.portrait.alt = '';
        this.statusEl.setAttribute('role', 'status');
        this.statusEl.setAttribute('aria-live', 'polite');
        this.preview.muted = true;
        this.preview.playsInline = true;
        this.preview.setAttribute('aria-label', 'Your camera');
        this.muteButton = gameButton('btn', () => void this.toggleMute(), 'Mute');
        this.cameraButton = gameButton('btn', () => void this.toggleCamera(), 'Camera on');
        this.chooseEl = el('div', 'voice__choose',
            gameButton('btn btn--primary', () => void this.callInGame(), 'Call in game'),
            gameButton('btn', () => void this.callOnFaceTime(), 'Call on FaceTime'),
            el('p', 'voice__hint', 'In game uses your microphone, and your camera if you turn it on, so your teacher can see your worksheet. FaceTime uses EDUROAM\'s shared FaceTime line.'));
        this.actionsEl = el('div', 'voice__actions hidden', this.muteButton, this.cameraButton, gameButton('btn btn--danger', () => void this.close(), 'End call'));
        this.root = el('section', 'voice panel hidden',
            el('header', 'voice__head', this.portrait,
                el('div', 'voice__title', this.nameEl, el('span', 'voice__label', 'FaceTime Tutor ', this.timerEl)),
                iconButton('tutor__close', 'close', 'End call (Esc)', () => void this.close())),
            this.statusEl, this.chooseEl, this.facetimeEl, this.preview, this.actionsEl,
            keyHints([['Esc', 'end call']]),
            this.audio);
        this.root.setAttribute('role', 'dialog');
        this.root.setAttribute('aria-label', 'Call with teacher');
        parent.append(this.root);
    }

    get isOpen ()
    {
        return this.record !== null;
    }

    open (record: NpcRecord, portrait: string, onClose: () => void)
    {
        this.generation++;
        this.record = record;
        this.onClose = onClose;
        this.portrait.src = portrait;
        this.nameEl.textContent = record.name;
        this.root.classList.remove('hidden', 'speaking');
        this.setPhase('choose');
        this.setStatus(`Talk to ${record.name}. How do you want to call?`);
    }

    handleKey (key: string)
    {
        if (key === 'escape') void this.close();
    }

    async close ()
    {
        if (!this.record) return;
        this.generation++;
        this.record = null;
        const disconnected = this.hangUp();
        this.root.classList.add('hidden');
        const done = this.onClose;
        this.onClose = null;
        done?.();
        await disconnected;
    }

    async endForNpc (npcId: string)
    {
        if (this.record?.id === npcId) await this.close();
    }

    // ------------------------------------------------------------------ state

    private setPhase (phase: Phase)
    {
        this.root.dataset.phase = phase;
        this.chooseEl.classList.toggle('hidden', phase !== 'choose' && phase !== 'ended');
        this.facetimeEl.classList.toggle('hidden', phase !== 'facetime');
        this.actionsEl.classList.toggle('hidden', phase !== 'in-call' && phase !== 'connecting');
        this.statusEl.classList.toggle('is-busy', phase === 'connecting');
        this.muteButton.disabled = phase !== 'in-call';
        this.cameraButton.disabled = phase !== 'in-call';
        if (phase !== 'in-call' && phase !== 'facetime') this.stopTicker();
    }

    private setStatus (text: string, isError = false)
    {
        this.statusEl.textContent = text;
        this.statusEl.classList.toggle('is-error', isError);
    }

    private startTicker (render: () => void)
    {
        this.stopTicker();
        render();
        this.ticker = setInterval(render, 1000);
    }

    private stopTicker ()
    {
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        this.timerEl.textContent = '';
    }

    /** Leaves the room (the agent then saves the learning summary) and releases mic + camera. */
    private hangUp ()
    {
        const room = this.room;
        this.room = null;
        this.camera?.stop();
        this.camera = null;
        this.preview.srcObject = null;
        this.preview.classList.add('hidden');
        this.audio.replaceChildren();
        this.stopTicker();
        this.muted = false;
        this.muteButton.textContent = 'Mute';
        this.cameraButton.textContent = 'Camera on';
        return room?.disconnect();
    }

    /** The account's existing backend NPC (read-only). Errors here are lookup errors, not call errors. */
    private async teacher (record: NpcRecord): Promise<RemoteNpc>
    {
        if (!(await getSession())) throw new TutorApiError('unauthenticated', 'Sign in (top right) to call your teacher.');
        let remote: RemoteNpc | null;
        try { remote = await findRemoteNpc(record); }
        catch (err)
        {
            console.warn('[VoicePanel] NPC lookup failed', err);
            throw new TutorApiError('lookup_failed', 'Could not reach the tutoring server to find this teacher. Check your connection and try again.', true);
        }
        if (!remote) throw new TutorApiError('npc_not_synced', `${record.name} isn't set up for tutoring on your account yet. Open Chat & Study with them once, then call again.`);
        return remote;
    }

    // ------------------------------------------------------------------ in-game call (LiveKit)

    private async callInGame ()
    {
        const record = this.record;
        if (!record || this.room) return; // never two rooms at once
        const generation = ++this.generation;
        const stale = () => generation !== this.generation;
        this.setPhase('connecting');
        this.setStatus(`Calling ${record.name}…`);
        try
        {
            const remote = await this.teacher(record);
            if (stale()) return;
            const call = await startVoiceCall(remote);
            if (stale()) return;
            const { Room, RoomEvent, Track } = await import('livekit-client');
            if (stale()) return;
            const room = new Room({ adaptiveStream: true, dynacast: true });
            this.room = room;
            room.on(RoomEvent.TrackSubscribed, (track) =>
            {
                if (track.kind === Track.Kind.Audio && !stale()) this.audio.append(track.attach());
            });
            room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((node) => node.remove()));
            room.on(RoomEvent.ParticipantConnected, () => { if (!stale()) this.setStatus(`${call.npcName} joined. Start talking!`); });
            room.on(RoomEvent.ParticipantDisconnected, () => { if (!stale() && !room.remoteParticipants.size) this.setStatus(`${call.npcName} left the call.`, true); });
            room.on(RoomEvent.ActiveSpeakersChanged, (speakers) =>
            {
                this.root.classList.toggle('speaking', speakers.some((p) => p.identity !== room.localParticipant.identity));
            });
            room.on(RoomEvent.Disconnected, () =>
            {
                if (stale()) return;
                this.hangUp();
                this.setPhase('ended');
                this.setStatus('Call ended. Your teacher saved what you studied.');
            });
            await room.connect(call.serverUrl, call.token);
            if (stale()) { void room.disconnect(); return; }
            await room.localParticipant.setMicrophoneEnabled(true);
            if (stale()) return;
            this.setPhase('in-call');
            this.startedAt = Date.now();
            this.startTicker(() => { this.timerEl.textContent = clock(Date.now() - this.startedAt); });
            this.setStatus(room.remoteParticipants.size ? `In a call with ${call.npcName}.` : `Waiting for ${call.npcName} to join…`);
            // The server dispatched the tutor, but no agent server may be running for it: say so instead of waiting forever.
            window.setTimeout(() =>
            {
                if (stale() || this.room !== room || room.remoteParticipants.size) return;
                this.generation++;
                void this.hangUp();
                this.setPhase('choose');
                this.setStatus(`${call.npcName} could not join the call: the voice tutor is offline right now. Please try again later.`, true);
            }, AGENT_JOIN_TIMEOUT_MS);
        }
        catch (err)
        {
            if (stale()) return;
            this.hangUp();
            this.setPhase('choose');
            this.setStatus(errorText(err), true);
        }
    }

    private async toggleMute ()
    {
        const room = this.room;
        if (!room) return;
        this.muted = !this.muted;
        await room.localParticipant.setMicrophoneEnabled(!this.muted);
        this.muteButton.textContent = this.muted ? 'Unmute' : 'Mute';
        this.setStatus(this.muted ? 'Microphone muted.' : 'Listening.');
    }

    /** Shows the camera to the tutor (Gemini samples frames) and a small preview to aim the page. */
    private async toggleCamera ()
    {
        const room = this.room;
        if (!room) return;
        this.cameraButton.disabled = true;
        try
        {
            if (this.camera)
            {
                await room.localParticipant.unpublishTrack(this.camera);
                this.camera.stop();
                this.camera = null;
                this.preview.srcObject = null;
                this.preview.classList.add('hidden');
                this.cameraButton.textContent = 'Camera on';
                this.setStatus('Camera off. Your teacher can no longer see you.');
                return;
            }
            const { createLocalVideoTrack, VideoPresets } = await import('livekit-client');
            const track = await createLocalVideoTrack({ resolution: VideoPresets.h720.resolution, facingMode: 'environment' });
            if (this.room !== room) { track.stop(); return; }
            await room.localParticipant.publishTrack(track);
            this.camera = track;
            track.attach(this.preview);
            this.preview.classList.remove('hidden');
            this.cameraButton.textContent = 'Camera off';
            this.setStatus('Camera on. Hold your worksheet up, close and steady, and ask about it.');
        }
        catch (err)
        {
            this.setStatus(errorText(err), true);
        }
        finally { this.cameraButton.disabled = !this.room; }
    }

    // ------------------------------------------------------------------ shared Chert FaceTime line

    private async callOnFaceTime ()
    {
        const record = this.record;
        if (!record || this.room) return;
        const generation = ++this.generation;
        const stale = () => generation !== this.generation;
        this.setPhase('connecting');
        this.actionsEl.classList.add('hidden');
        this.setStatus('Getting your FaceTime code…');
        try
        {
            const remote = await this.teacher(record);
            if (stale()) return;
            const pairing = await startFaceTimeCall(remote);
            if (stale()) return;
            const code = el('strong', 'voice__code', pairing.code.replace(/(\d{3})(\d{3})/, '$1 $2'));
            code.setAttribute('aria-label', `Code ${pairing.code.split('').join(' ')}`);
            const expires = el('span', 'voice__hint');
            this.facetimeEl.replaceChildren(
                el('p', '', 'On your phone, FaceTime ', el('strong', 'voice__line', pairing.line), '. When the tutor answers, say this code:'),
                code, expires,
                ...(pairing.lineBusy ? [el('p', 'voice__hint is-warning', 'Someone is on the line right now. If it is busy, wait a moment and call again; the code works for 5 minutes.')] : []),
                el('p', 'voice__hint', `Then you are talking with ${pairing.npcName}. When you hang up, what you studied is saved for Chat & Study.`),
                el('div', 'voice__actions', gameButton('btn', () => void this.callOnFaceTime(), 'New code'), gameButton('btn', () => void this.close(), 'Done')));
            this.setPhase('facetime');
            this.setStatus(`Call ${pairing.npcName} on FaceTime`);
            this.startTicker(() =>
            {
                const left = pairing.expiresAt - Date.now();
                expires.textContent = left > 0 ? `Code expires in ${clock(left)}` : 'This code expired. Get a new code.';
                if (left <= 0) this.stopTicker();
            });
        }
        catch (err)
        {
            if (stale()) return;
            this.setPhase('choose');
            this.setStatus(errorText(err), true);
        }
    }
}
