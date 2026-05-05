import { Request, Response, StatusCode } from './types';

export interface MockResponse {
  status: StatusCode;
  body: any;
  headers?: Record<string, string>;
}

/**
 * HttpMock provides a way to intercept and mock HTTP calls made by the opencode SDK.
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
 * // When the SDK calls /api/v1/resource, it will receive the mocked response
 * ```
 * 
 * @class HttpMock
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