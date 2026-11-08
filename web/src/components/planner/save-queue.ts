/**
 * Planner saves run one at a time, in order (a later PATCH never lands before an earlier one), and anything that
 * reads the stored row (share link, status) can wait for them with idle(). Failures are swallowed: the planner keeps
 * its state, and the next save carries the full home + locks again.
 */
export function createSaveQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    push(task: () => Promise<unknown>) {
      tail = tail.then(task).then(
        () => undefined,
        () => undefined,
      );
      return tail;
    },
    idle: () => tail,
  };
}
