import { startApp } from './game/app';

// Sign-in first: the game starts only after Supabase confirms the account (see game/app.ts).
document.addEventListener('DOMContentLoaded', () => {

    void startApp('game-container');

});
