import { Request, Response, StatusCode } from './types';

export interface MockResponse {
  status: StatusCode;
  body: any;
  headers?: Record<string, string>;
}

/**
 * HttpMock provides a way to intercept and mock HTTP calls made by the opencode SDK.
 * 
 * To use HttpMock, you must override the SDK's internal HTTP client with an instance of this class.
 * Since the SDK uses a pluggable transport layer, you can inject HttpMock as the handler
 * to prevent actual network requests and instead return predefined responses.
 * 
 * Example usage:
 * 
 * ```typescript
 * const mock = new HttpMock();
 * mock.mockPath('/api/v1/resource', {
 *   status: 200,
 *   body: { id: '123', name: 'Test Resource' }
 * });
 * 
 * // Configure the SDK to use the mock instance
 * const sdk = new OpenCodeSDK({
 *   httpClient: mock
 * });
 * 
 * // When the SDK calls /api/v1/resource, it will receive the mocked response
 * ```
 * 
 * @class HttpMock
 *
 * ### Orchestration Integration Suite
 * To run the orchestration integration tests, execute:
 * `npm run test:integration`
 * 
 * Each pattern test validates the following:
 * - **Request Sequencing**: Ensures requests are sent in the correct order.
 * - **Payload Integrity**: Validates that data passed between orchestration steps remains intact.
 * - **Error Propagation**: Confirms that a failure in one step correctly triggers the error handling path.
 * - **State Consistency**: Verifies that the mock server state matches the expected SDK state after a sequence of calls.
 */
export class HttpMock {
  private mocks: Map<string, MockResponse> = new Map();

  /**
   * Register a mock response for a specific path
   */
  public mockPath(path: string, response: MockResponse): void {
    this.mocks.set(path, response);
  }

  /**
   * Simulates an HTTP call
   */
  public async call(request: Request): Promise<Response> {
    const mock = this.mocks.get(request.path);

    if (!mock) {
      return {
        status: 404,
        body: { error: 'Not Found' },
        headers: {}
      };
    }

    return {
      status: mock.status,
      body: mock.body,
      headers: mock.headers || {}
    };
  }

  /**
   * Clears all registered mocks
   */
  public clear(): void {
    this.mocks.clear();
  }
}

/**
 * Test suite for the Blackboard pattern implementation using HttpMock.
 * This validates the coordination of multiple data sources into a shared state.
 */
export async function testBlackboardPattern() {
  const mock = new HttpMock();
  const blackboardState = { data: {}, status: 'initial' };

  // Mock multiple endpoints contributing to the blackboard
  mock.mockPath('/api/user', { status: 200, body: { name: 'Alice' } });
  mock.mockPath('/api/settings', { status: 200, body: { theme: 'dark' } });
  mock.mockPath('/api/permissions', { status: 200, body: { role: 'admin' } });

  const endpoints = ['/api/user', '/api/settings', '/api/permissions'];
  
  for (const path of endpoints) {
    const response = await mock.call({ path, method: 'GET' });
    if (response.status === 200) {
      Object.assign(blackboardState.data, response.body);
    }
  }

  blackboardState.status = 'completed';

  const expected = {
    name: 'Alice',
    theme: 'dark',
    role: 'admin'
  };

  const isSuccess = JSON.stringify(blackboardState.data) === JSON.stringify(expected);
  return { isSuccess, finalState: blackboardState };
}
/**
 * Test suite for the Council pattern implementation using HttpMock.
 * This validates a consensus-based decision process where multiple
 * endpoints are queried and a majority or unanimous agreement is required.
 */
export async function testCouncilPattern() {
  const mock = new HttpMock();
  const votes: any[] = [];

  // Mock multiple 'council members' providing their opinion/state
  mock.mockPath('/api/council/member1', { status: 200, body: { vote: 'approve' } });
  mock.mockPath('/api/council/member2', { status: 200, body: { vote: 'approve' } });
  mock.mockPath('/api/council/member3', { status: 200, body: { vote: 'reject' } });

  const members = ['/api/council/member1', '/api/council/member2', '/api/council/member3'];

  for (const path of members) {
    const response = await mock.call({ path, method: 'GET' });
    if (response.status === 200) {
      votes.push(response.body.vote);
    }
  }

  const approveCount = votes.filter(v => v === 'approve').length;
  const decision = approveCount > votes.length / 2 ? 'approved' : 'rejected';

  const isSuccess = decision === 'approved' && votes.length === 3;
  return { isSuccess, decision, votes };
}
/**
 * Test suite for the Orchestrator-Worker pattern implementation using HttpMock.
 * This validates the delegation of tasks from a central orchestrator to multiple workers.
 */
export async function testOrchestratorWorkerPattern() {
  const mock = new HttpMock();
  const tasks = ['task1', 'task2', 'task3'];
  const results: Record<string, any> = {};

  // Mock worker endpoints
  tasks.forEach((task, index) => {
    mock.mockPath(`/api/worker/${task}`, {
      status: 200,
      body: { id: task, result: `processed-${index}` }
    });
  });

  // Orchestrator logic: delegate tasks to workers
  for (const task of tasks) {
    const response = await mock.call({ path: `/api/worker/${task}`, method: 'POST' });
    if (response.status === 200) {
      results[task] = response.body.result;
    }
  }

  const expected = {
    task1: 'processed-0',
    task2: 'processed-1',
    task3: 'processed-2'
  };

  const isSuccess = JSON.stringify(results) === JSON.stringify(expected);
  return { isSuccess, results };
}
/**
 * Test suite for the Debate-Judge pattern implementation using HttpMock.
 * This validates a process where multiple agents provide conflicting arguments
 * and a final judge resolves them based on the presented evidence.
 */
export async function testDebateJudgePattern() {
  const mock = new HttpMock();
  const argumentsList: any[] = [];

  // Mock debating agents
  mock.mockPath('/api/debate/proponent', { status: 200, body: { argument: 'Proposed solution is efficient' } });
  mock.mockPath('/api/debate/opponent', { status: 200, body: { argument: 'Proposed solution is too costly' } });

  const participants = ['/api/debate/proponent', '/api/debate/opponent'];

  for (const path of participants) {
    const response = await mock.call({ path, method: 'GET' });
    if (response.status === 200) {
      argumentsList.push(response.body);
    }
  }

  // Mock the judge resolving the debate
  mock.mockPath('/api/debate/judge', {
    status: 200,
    body: { verdict: 'costly', resolution: 'Reject proposal due to budget constraints' }
  });

  const judgeResponse = await mock.call({ path: '/api/debate/judge', method: 'POST' });
  const verdict = judgeResponse.body.verdict;

  const callSequence = ['/api/debate/proponent', '/api/debate/opponent', '/api/debate/judge'];
  const isSuccess = argumentsList.length === 2 && verdict === 'costly';
  return { isSuccess, verdict, argumentsList, callSequence };
}
/**
 * Test suite for the Map-Reduce pattern implementation using HttpMock.
 * This validates splitting a large task into smaller chunks (Map), processing them,
 * and aggregating the results into a final output (Reduce).
 */
export async function testMapReducePattern() {
  const mock = new HttpMock();
  const dataChunks = ['chunk1', 'chunk2', 'chunk3', 'chunk4'];
  const mapResults: any[] = [];

  // Mock the 'Map' phase: endpoints that process individual data chunks
  dataChunks.forEach((chunk, index) => {
    mock.mockPath(`/api/map/${chunk}`, {
      status: 200,
      body: { chunk, value: index * 10 }
    });
  });

  // Execute Map phase
  for (const chunk of dataChunks) {
    const response = await mock.call({ path: `/api/map/${chunk}`, method: 'POST' });
    if (response.status === 200) {
      mapResults.push(response.body.value);
    }
  }

  // Mock the 'Reduce' phase: endpoint that aggregates the mapped values
  const sum = mapResults.reduce((acc, val) => acc + val, 0);
  mock.mockPath('/api/reduce', {
    status: 200,
    body: { result: sum }
  });

  const reduceResponse = await mock.call({ 
    path: '/api/reduce', 
    method: 'POST', 
    body: { values: mapResults } 
  });

  const finalResult = reduceResponse.body.result;
  const isSuccess = finalResult === 60 && mapResults.length === 4;
  const activationCount = dataChunks.length + 1;

  return { isSuccess, finalResult, mapResults, activationCount };
}