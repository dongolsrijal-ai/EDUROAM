// DUNGEON CHEST REWARDS. Every chest (side chests and the final treasure chest) pays the same
// crystal reward, the village-decoration currency (progression/balance.ts CHEST_CRYSTALS).
// Combat power never comes from loot: weapons improve through stat points.

import { CHEST_CRYSTALS } from '../progression/balance';
import { CURRENCY } from '../shop/catalog';
import type { ItemId } from './itemDefs';

export function chestReward (): { itemId: ItemId; qty: number }
{
    return { itemId: CURRENCY, qty: CHEST_CRYSTALS };
}
