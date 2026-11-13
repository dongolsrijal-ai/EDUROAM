// Sir Sum-a-Lot's beginner arithmetic challenge. Edit / add questions freely.

import type { Challenge } from './challenge';

export const MATH_CHALLENGE: Challenge = {
    id: 'sir-sum-a-lot-math-1',
    title: "Sir Sum-a-Lot's Math Challenge",
    passScore: 2,
    reward: { item: 'number_crystal', amount: 3, label: 'Number Crystals' },
    questions: [
        {
            prompt: 'What is 7 + 5?',
            options: ['10', '11', '12', '13'],
            answer: 2,
            explanation: '7 + 3 makes 10, then 2 more makes 12.',
        },
        {
            prompt: 'What is 9 x 3?',
            options: ['27', '21', '24', '30'],
            answer: 0,
            explanation: '9 x 3 means three nines: 9 + 9 + 9 = 27.',
        },
        {
            prompt: 'What is 20 - 8?',
            options: ['14', '12', '11', '13'],
            answer: 1,
            explanation: '20 - 10 = 10, but we only took 8, so add 2 back: 12.',
        },
    ],
};
