export const TRANSLATE_QUEUE = '{droneaid-translate}';
export const TRANSLATE_TICK_JOB = 'droneaid-translate-tick';
export const TRANSLATE_SCHEDULER_ID = 'droneaid-translate-scheduler';
/** One tick every 30 s, as in our AFFiNE fork. */
export const TRANSLATE_TICK_MS = 30_000;
/** Stop picking new rows after this, so a tick stays inside its slot. */
export const TICK_BUDGET_MS = 20_000;
/** Kicks within this window share one tick. */
export const KICK_DEBOUNCE_MS = 2_000;
/** Job id of the pending kick: BullMQ ignores a second add with the same id. */
export const TRANSLATE_KICK_JOB_ID = 'droneaid-translate-kick';
