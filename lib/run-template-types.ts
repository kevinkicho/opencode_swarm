// Persisted run template — saves the configuration from the new-run modal
// so the operator can one-click relaunch common patterns. Excludes
// sourceValue and workspacePath (those are per-run-specific).

import type { BranchStrategy, StartMode } from '../components/new-run/helpers';
import type { SwarmPattern } from './swarm-types';

export interface RunTemplate {
  name: string;
  pattern: SwarmPattern;
  directive: string;
  teamCounts: Record<string, number>;
  unbounded: boolean;
  costCap: number;
  minutesCap: number;
  branchStrategy: BranchStrategy;
  persistentSweepMinutes: number;
  enableSynthesisCritic: boolean;
  startMode: StartMode;
  createdAt: number;
}
