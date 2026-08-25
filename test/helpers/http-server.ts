/**
 * Local HTTP fixtures: an origin that reports the address it was reached on,
 * a redirector, and a server that sends more bytes than you asked for.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'

export interface TestServer {
  readonly port: number
  readonly origin: string
  /** The remote address of every connection the server accepted. */
  readonly hits: Array<{ url: string; host: string | undefined }>
  close(): Promise<void>
}

export async function startHttpServer(
  handler: (
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ) => void,
): Promise<TestServer> {
  const hits: Array<{ url: string; host: string | undefined }> = []
  const server = http.createServer((request, response) => {
    hits.push({ url: request.url ?? '', host: request.headers.host })
    handler(request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** An origin that echoes a fixed body, so a test can prove where it landed. */
export function echoServer(body: string) {
  return startHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(body)
  })
}
