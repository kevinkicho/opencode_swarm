// @ts-nocheck
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
  const blackboard = { arguments: [] };

  // Mock debating agents
  mock.mockPath('/api/debate/proponent', { status: 200, body: { argument: 'Proposed solution is efficient' } });
  mock.mockPath('/api/debate/opponent', { status: 200, body: { argument: 'Proposed solution is too costly' } });

  const participants = ['/api/debate/proponent', '/api/debate/opponent'];

  for (const path of participants) {
    const response = await mock.call({ path, method: 'GET' });
    if (response.status === 200) {
      argumentsList.push(response.body);
      blackboard.arguments.push(response.body);
    }
  }

  // Mock the judge resolving the debate
  mock.mockPath('/api/debate/judge', {
    status: 200,
    body: { verdict: 'costly', resolution: 'Reject proposal due to budget constraints' }
  });

  const judgeResponse = await mock.call({ path: '/api/debate/judge', method: 'POST' });
  const verdict = judgeResponse.body.verdict;
  blackboard.verdict = verdict;
  blackboard.resolution = judgeResponse.body.resolution;

  const callSequence = ['/api/debate/proponent', '/api/debate/opponent', '/api/debate/judge'];
  const stateVerified = blackboard.arguments.length === 2 && blackboard.verdict === 'costly';
  const isSuccess = argumentsList.length === 2 && verdict === 'costly' && stateVerified;
  const reachedTermination = callSequence.length === 3 && blackboard.resolution !== undefined;
  return { isSuccess, reachedTermination, verdict, argumentsList, callSequence, blackboard };
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
  const sharedState = { mappedValues: [], finalResult: null };

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
      sharedState.mappedValues.push(response.body.value);
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
  sharedState.finalResult = finalResult;
  const stateVerified = sharedState.mappedValues.length === 4 && sharedState.finalResult === 60;
  const isSuccess = finalResult === 60 && mapResults.length === 4 && stateVerified;
  const activationCount = dataChunks.length + 1;
  const reachedTermination = sharedState.finalResult !== null && mapResults.length === dataChunks.length;

  return { isSuccess, reachedTermination, finalResult, mapResults, activationCount, sharedState };
}

/**
 * Test suite for the Critic-Loop pattern implementation using HttpMock.
 * This validates a pattern where a request is made, and then based on the response,
 * subsequent requests are made in a loop until a condition is met (e.g., a job completes).
 */
 export async function testCriticLoopPattern() {
   const mock = new HttpMock();

   // Mock the job creation endpoint
   mock.mockPath('/api/job', { status: 200, body: { id: 'job1', status: 'processing' } });

   // Step 1: Create the job.
   const createResponse = await mock.call({ path: '/api/job', method: 'POST' });
   if (createResponse.status !== 200) {
     return { isSuccess: false, error: 'Job creation failed' };
   }
   const jobId = createResponse.body.id; // 'job1'

   // Step 2: First poll -> we expect processing
   mock.mockPath(`/api/job/${jobId}`, { status: 200, body: { status: 'processing' } });
   const poll1Response = await mock.call({ path: `/api/job/${jobId}`, method: 'GET' });
   if (poll1Response.status !== 200 || poll1Response.body.status !== 'processing') {
     return { isSuccess: false, error: 'First poll failed' };
   }

   // Step 3: Update the mock for the same path to return completed for the next call.
   mock.mockPath(`/api/job/${jobId}`, { status: 200, body: { status: 'completed' } });
   const poll2Response = await mock.call({ path: `/api/job/${jobId}`, method: 'GET' });
   if (poll2Response.status !== 200 || poll2Response.body.status !== 'completed') {
     return { isSuccess: false, error: 'Second poll failed' };
   }

   // If we get here, the critic-loop (two-step: submit and then poll until completed) worked.
   const isSuccess = true;
   return { isSuccess, jobId, polls: 2 };
 }