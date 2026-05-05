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