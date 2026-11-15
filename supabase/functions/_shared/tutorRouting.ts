// Per-message routing for tutoring: whether Google Search is OFFERED to the model this turn,
// and how hard the model should think. Pure TypeScript, shared by the Edge Functions and the
// game (which only uses it to show a "researching online" indicator).
//
// Search is opt-in by message, never on by default: plain explanations, definitions and
// arithmetic are answered from coursework / general knowledge. When search is offered the
// model still decides automatically whether a query is actually needed.

import type { GeminiTask } from './gemini.ts';

/** The student explicitly asks for online research or verification. */
const EXPLICIT_SEARCH = /\b(search|google|look (?:it |this |that )?up|research(?:ing)? (?:online|it|this)|browse|on the (?:web|internet)|online sources?|find (?:me |some |other |another |alternative |more |different )*(?:sources|articles|websites|links|pages|resources)|(?:other|alternative|different) (?:sources|websites|resources)|fact[- ]?check|verify (?:this|that|it|whether|if)|cite (?:a )?sources?)\b/i;

/** The answer depends on information that may be newer than the model (or needs verifying). */
const RECENT = /\b(latest|most recent|recent(?:ly)?|nowadays|these days|this (?:week|month|year)|last (?:week|month)|today'?s?|breaking|news|newest|new(?:ly)? (?:discovered|announced|released|published)|just (?:discovered|announced|released)|breakthroughs?|discover(?:ed|ies) (?:this|last) year|as of (?:19|20)\d\d|in 20(?:2[5-9]|3\d)|20(?:2[6-9]|3\d))\b/i;

/** Clearly self-contained maths: never worth a web search. */
const PURE_ARITHMETIC = /^[\s\d+\-*/^().,=x×÷%?]*$/i;

/** True if Google Search should be available to the model for this message. */
export function wantsWebSearch (message: string): boolean
{
    // Links are read directly (URL context); words inside an address never trigger a search.
    const text = message.replace(/\bhttps?:\/\/\S+/gi, ' ').trim();
    if (!text || PURE_ARITHMETIC.test(text)) return false;
    return EXPLICIT_SEARCH.test(text) || RECENT.test(text);
}

const CASUAL = /^(?:hi|hii+|hello|hey|yo|thanks?|thank you|thx|ok(?:ay)?|k|yes|yeah|yep|no|nope|sure|cool|great|nice|bye|goodbye|see you|good (?:morning|afternoon|evening|night)|lol|got it|i see)\b[\s!.?,:)]*$/i;

const COMPLEX = /\b(solve|prove|proof|derive|derivation|step[- ]by[- ]step|show (?:your |the )?work|calculate|compute|equation|integral|integrate|derivative|differentiate|limit of|probability|factori[sz]e|simplify|balance|stoichiometr\w*|mechanism|why does|why do|how does|how do .+ work|explain (?:why|how)|compare and contrast|word problem)\b|\d\s*[-+*/^=×÷]\s*\d|\b[a-z]\s*[\^=]\s*\d/i;

/** Thinking task for one tutoring message (see DEFAULT_THINKING in gemini.ts). */
export function tutoringTask (message: string, hasImage = false): GeminiTask
{
    const text = message.trim();
    if (hasImage || text.length > 280 || COMPLEX.test(text)) return 'complex';
    if (text.length <= 40 && CASUAL.test(text)) return 'casual';
    return 'tutoring';
}
