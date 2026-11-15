import { npcStore } from '../../src/game/data/npcStore';
import { loadNpcRoster, syncNpc } from '../../src/game/services/tutorApi';
import { log, USER_ID } from './authStub';
import type { Ui } from '../../src/game/ui';

export async function runNpcDeletionPhase (ui: Ui, until: (fn: () => unknown, label: string) => Promise<void>, check: (v: unknown, message: string) => void)
{
    const created = npcStore.create({ id: 'npc_delete_browser', name: 'Delete Test', subject: 'Mathematics', appearance: 'scientist', dialogue: [], minigameType: null }, { map: 'hub', x: 500, y: 500, npcX: 520, npcY: 550 });
    if (!created.ok) throw new Error(created.error);
    const remote = await syncNpc(created.value);
    const find = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.manager button')].find((b) => b.textContent?.includes(label));
    find('NPCs')!.click();
    await until(() => document.querySelector('.npc-list__report')?.textContent?.includes(remote.id), 'authoritative comparison');
    const row = () => [...document.querySelectorAll<HTMLElement>('.npc-row')].find((r) => r.textContent?.includes('Delete Test'));
    const remove = () => [...row()!.querySelectorAll<HTMLButtonElement>('button')].find((b) => /Delet/.test(b.textContent ?? ''))!;
    let confirmation = '';
    window.confirm = (text) => { confirmation = text; return true; };
    const writes = log.npcWrites;
    ui.voice.open(created.value, '', () => {});
    const voiceStarts = log.voiceStarts.length;
    [...document.querySelectorAll<HTMLButtonElement>('.voice button')].find((b) => b.textContent === 'Call in game')!.click();
    await until(() => log.voiceStarts.length > voiceStarts, 'voice request');
    check(log.npcWrites === writes, 'voice startup must not write NPCs');
    localStorage.setItem('stub.failNpcDelete', '1');
    remove().click();
    check(Boolean(npcStore.get(created.value.id)), 'NPC stays in village while server request is pending');
    await until(() => !remove().disabled && document.body.textContent?.includes('Private file cleanup failed'), 'deletion failure shown');
    check(Boolean(npcStore.get(created.value.id)), 'failed cleanup preserves NPC');
    check(!ui.voice.isOpen, 'matching voice call ended before deletion');
    check(/private tutoring history.*memories.*private uploads/.test(confirmation), 'confirmation explains permanent private-data removal');
    localStorage.removeItem('stub.failNpcDelete');
    remove().click();
    await until(() => !npcStore.get(created.value.id), 'server-confirmed teacher removal');
    check(!row(), 'deleted NPC disappears from manager');
    await until(() => document.querySelector('.npc-list__report')?.textContent?.includes('npc_delete_browser'), 'comparison includes deletion marker');
    await syncNpc(created.value).then(() => { throw new Error('stale sync unexpectedly succeeded'); }, (err) => check(/deleted/.test(err.message), 'stale sync is rejected'));
    check(log.npcWrites === writes, 'deletion and stale sync never insert replacement NPCs');
}

/** Delete All My NPCs: three extra server-only NPCs (not in this village), typed confirmation. */
export async function runNpcDeleteAllPhase (until: (fn: () => unknown, label: string) => Promise<void>, check: (v: unknown, message: string) => void)
{
    await until(() => document.querySelector('.npc-list__usage')?.textContent?.includes('Server NPCs') && npcStore.all().length, 'signed-in session restored');
    const template = npcStore.all()[0];
    for (const n of [1, 2, 3]) await syncNpc({ ...template, id: `npc_server_only_${n}`, name: `Server Only ${n}` });
    [...document.querySelectorAll<HTMLButtonElement>('.manager button')].find((b) => b.textContent?.includes('NPCs'))!.click();
    await until(() => document.querySelector('.npc-list__report')?.textContent?.includes('npc_server_only_3'), 'comparison loaded');
    const serverBefore = (await loadNpcRoster()).npcs;
    const total = serverBefore.length + npcStore.all().filter((n) => !serverBefore.some((s) => s.game_npc_id === n.id)).length;
    check(serverBefore.filter((n) => n.game_npc_id.startsWith('npc_server_only_')).length === 3, 'setup: 3 server-only NPCs');
    const box = document.querySelector<HTMLDetailsElement>('.npc-bulk')!;
    box.open = true;
    const input = box.querySelector<HTMLInputElement>('input')!;
    const button = box.querySelector<HTMLButtonElement>('button')!;
    const status = () => box.querySelector('.npc-bulk__status')!.textContent ?? '';
    const type = (text: string) => { input.value = text; input.dispatchEvent(new Event('input')); };
    type('delete all');
    check(button.disabled, 'button stays disabled until DELETE ALL is typed exactly');
    const calls = log.lifecycle.length;
    type('DELETE ALL');
    check(!button.disabled, 'typed confirmation enables the button');
    localStorage.setItem('stub.failNpcDeleteAtCall', String(calls + 2));
    button.click();
    await until(() => status().includes(`Stopped after deleting 1 of ${total}: Private file cleanup failed`), 'failure shows progress + specific error');
    check((await loadNpcRoster()).npcs.length === serverBefore.length - 1, 'failed NPC and the rest were kept');
    await until(() => !button.disabled, 'retry available');
    button.click();
    await until(() => /Server NPCs: 0 · In this village: 0 · NPCs 0\/10/.test(status()), 'retry deletes the remaining and verifies 0/0');
    const bulk = log.lifecycle.slice(calls);
    const serverCalls = bulk.filter((b) => serverBefore.some((n) => n.id === b.npc_id));
    check(bulk.length === total + 1 && bulk.every((b) => b.expected_owner_id === USER_ID), 'sequential calls with the authenticated owner; retry re-sends only the failed + remaining');
    check(serverCalls.every((b) => b.action === 'delete') && new Set(serverCalls.map((b) => b.npc_id)).size === serverBefore.length, 'every server NPC deleted by its database npc_id');
    check((await loadNpcRoster()).deletions.filter((d) => /npc_server_only_/.test(d.game_npc_id)).length === 3, 'deletion tombstones kept');
    check([...document.querySelectorAll('.manager__bar button')].some((b) => b.textContent === 'NPCs 0/10'), 'manager shows NPCs 0/10');
}
