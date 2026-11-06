/**
 * Stick-to-bottom behaviour for a chat that grows while you read it. Pure so the rules can be tested:
 * follow the stream only while the reader is at the bottom, and let go the moment they scroll up.
 */
export const BOTTOM_THRESHOLD = 56;

export function isNearBottom(scrollTop: number, clientHeight: number, scrollHeight: number, threshold = BOTTOM_THRESHOLD): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= threshold;
}

/**
 * Next "should we follow?" value after a scroll event. `programmatic` scrolls (we moved the view ourselves
 * to follow content) never change it; a user scroll sets it from where they ended up.
 */
export function nextStick(prev: boolean, e: { scrollTop: number; clientHeight: number; scrollHeight: number; programmatic: boolean }): boolean {
  if (e.programmatic) return prev;
  return isNearBottom(e.scrollTop, e.clientHeight, e.scrollHeight);
}

/** Whether the "jump to latest" pill should show: reader scrolled away AND something new arrived since. */
export function showJumpPill(stick: boolean, unseen: number): boolean {
  return !stick && unseen > 0;
}
