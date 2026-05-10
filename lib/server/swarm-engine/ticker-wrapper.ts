//
// Engine facade over auto-ticker — re-exports startAutoTicker and
// stopAutoTicker so the swarm-engine can control runs without importing
// from blackboard/auto-ticker directly. This is the adapter boundary.
//

import 'server-only';

export { startAutoTicker } from '../blackboard/auto-ticker';
export { stopAutoTicker } from '../blackboard/auto-ticker';
