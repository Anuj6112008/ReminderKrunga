/*
 * ReminderKrunga push server - Workers entry point.
 *
 * All logic lives in worker-core.js. The runtime only accepts handler
 * exports at the top level (constants like CHAIN/GRACE would be rejected
 * with "Incorrect type for map entry"), so this file does nothing but
 * re-expose the two handlers as the default export.
 */
import { handleFetch, handleScheduled } from './worker-core.js';

export default {
  fetch: handleFetch,
  scheduled: handleScheduled
};
