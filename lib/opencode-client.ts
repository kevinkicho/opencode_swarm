export interface SessionResponse {
  sessionId: string;
}

export interface MessageResponse {
  status: string;
}

export interface Turn {
  turnId: string;
  role: string;
  content: string;
}

export interface ListTurnsResponse {
  turns: Turn[];
}

export type FetchImplementation = typeof fetch;

export async function createSession(
  baseUrl: string,
  options: { fetch?: FetchImplementation } = {}
) {
  const requestFetch = options.fetch || fetch;
  const response = await requestFetch(`${baseUrl}/sessions`, {
    method: 'POST',
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return (await response.json()) as SessionResponse;
}

export async function sendMessage(
  baseUrl: string,
  sessionId: string,
  message: string,
  options: { fetch?: FetchImplementation } = {}
) {
  const requestFetch = options.fetch || fetch;
  const response = await requestFetch(`${baseUrl}/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return (await response.json()) as MessageResponse;
}

export async function listTurns(
  baseUrl: string,
  sessionId: string,
  options: { fetch?: FetchImplementation } = {}
) {
  const requestFetch = options.fetch || fetch;
  const response = await requestFetch(`${baseUrl}/sessions/${sessionId}/turns`, {
    method: 'GET',
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return (await response.json()) as ListTurnsResponse;
}