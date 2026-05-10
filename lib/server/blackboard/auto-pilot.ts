import 'server-only';

export interface AutoPilotDecision {
  action: 'none' | 'raise_cap' | 'notify' | 'stop';
  reason: string;
  newCap?: number;
}

export function evaluateAutoPilot(
  totalCost: number,
  currentCap: number,
  todosCompleted: number,
  todosStale: number,
  plannerErrors: number,
  silentSessions: number,
  tickerRunning: boolean,
): AutoPilotDecision {
  const completionRate = todosCompleted / Math.max(1, todosCompleted + todosStale);
  
  // Rule 1: Auto-stop if 3+ consecutive planner errors with zero progress
  if (plannerErrors >= 3 && todosCompleted === 0 && tickerRunning) {
    return { action: 'stop', reason: '3 planner errors with zero output — likely provider issue' };
  }
  
  // Rule 2: Auto-stop if no progress after 30+ todos with 0 completed
  if (todosCompleted === 0 && todosStale >= 30) {
    return { action: 'stop', reason: '30 stale todos with zero completions — run is stuck' };
  }
  
  // Rule 3: Auto-raise cap by $2 if productive and near limit
  if (completionRate >= 0.85 && totalCost >= currentCap * 0.90 && tickerRunning) {
    return { action: 'raise_cap', reason: 'Productive run at 90% cap — auto-raising by $2', newCap: currentCap + 2 };
  }
  
  // Rule 4: Notify if spending is high with low completion rate
  if (totalCost >= 3 && completionRate < 0.5 && tickerRunning) {
    return { action: 'notify', reason: `High spend ($${totalCost.toFixed(2)}) with low completion rate (${(completionRate*100).toFixed(0)}%)` };
  }
  
  // Rule 5: Notify if silent sessions exceed 25% of total sessions
  if (silentSessions > 0 && tickerRunning) {
    return { action: 'notify', reason: `${silentSessions} silent session(s) detected` };
  }
  
  return { action: 'none', reason: 'Run is healthy' };
}
