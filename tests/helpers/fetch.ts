/** A scripted `fetch` for unit tests: records each request and answers from a route handler. */
export interface FakeRequest {
  url: URL
  method: string
  headers: Headers
  body: string | undefined
}

export interface FakeReply {
  status?: number
  /** JSON body, serialized as-is. */
  body?: unknown
  /** Raw text body, used when the payload is not JSON. */
  text?: string
  /** Raw bytes, used for attachment downloads. */
  bytes?: Uint8Array
  /** Raw body stream, used to exercise the incremental byte limit without a Content-Length. */
  stream?: ReadableStream<Uint8Array>
  headers?: Record<string, string>
}

export interface FakeNetwork {
  fetch: typeof fetch
  requests: FakeRequest[]
}

/** Builds a `fetch` from `route`; an unmatched request fails loudly instead of hitting the network. */
export function fakeFetch(route: (request: FakeRequest) => FakeReply | undefined): FakeNetwork {
  const requests: FakeRequest[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const request: FakeRequest = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    }
    requests.push(request)
    const reply = route(request)
    if (!reply) throw new Error(`No fake response for ${request.method} ${url}`)
    const payload: BodyInit | null = reply.stream ?? (reply.bytes ? new Uint8Array(reply.bytes).slice().buffer as ArrayBuffer
      : reply.text ?? (reply.body === undefined ? null : JSON.stringify(reply.body)))
    return new Response(payload, { status: reply.status ?? 200, headers: reply.headers })
  }
  return { fetch: fetchImpl as typeof fetch, requests }
}

/** The subset of Redmine's issue payload the tests need, as JSON. */
export const issueJson = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 12,
  subject: 'Issue 12',
  description: 'broken',
  project: { id: 1, name: 'dsh-test' },
  tracker: { id: 1, name: 'Bug' },
  status: { id: 2, name: 'In Progress' },
  author: { id: 7, name: 'Alice' },
  created_on: '2026-11-02T09:00:00+08:00',
  updated_on: '2026-11-02T10:00:00+08:00',
  journals: [],
  ...overrides,
})
