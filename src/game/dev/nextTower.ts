import { DEV } from './devFlags';
import { dungeonRun } from '../state/dungeonRun';
import { tower } from '../state/tower';
import { pomodoro } from '../state/pomodoro';
import { newRunOptions, reconcileTowerProgress, TOWER_RUN } from '../world/dungeon/runOptions';

/** Skip with no success/reward path. The saved new run is also a recovery record for its level. */
export function nextTower (): boolean
{
    if (!DEV) return false;
    if (!dungeonRun.state.active && !reconcileTowerProgress()) return false;
    const level = Math.max(tower.state.towerLevel, dungeonRun.state.active ? dungeonRun.state.towerLevel : 1) + 1;
    const options = newRunOptions(Math.random, dungeonRun.state.active ? dungeonRun.state.biomeId : tower.state.lastBiome, level);
    if (!dungeonRun.replace(TOWER_RUN, options)) return false;
    tower.setLevel(level);
    tower.setLastBiome(options.biomeId);
    pomodoro.skipFocus();
    pomodoro.enterDungeon();
    return true;
}
