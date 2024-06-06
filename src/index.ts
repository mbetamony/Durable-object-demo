import { DurableObject } from 'cloudflare:workers'

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/**
 * Associate bindings declared in wrangler.toml with the TypeScript type system
 */
export interface Env {
	// Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
	MY_DURABLE_OBJECT: DurableObjectNamespace<MyDurableObject>
}

/** A Durable Object's behavior is defined in an exported Javascript class */
export class MyDurableObject extends DurableObject {
	/**
	 * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
	 * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
	 *
	 * @param ctx - The interface for interacting with Durable Object state
	 * @param env - The interface to reference bindings declared in wrangler.toml
	 */
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env)
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname.endsWith('steps')) {
			return await this.handleStepsRequest(request)
		} else {
			return await this.handleListenRequest(request)
		}
	}

	async handleListenRequest(request: Request) {
		if (request.headers.get('Upgrade') != 'websocket') {
			return new Response('expected websocket', { status: 400 })
		}
		let pair = new WebSocketPair()
		this.ctx.acceptWebSocket(pair[1])
		return new Response(null, { status: 101, webSocket: pair[0] })
	}

	async handleStepsRequest(request: Request) {
		const newUrl = new URL(request.url)
		// we don't need those, unless its running locally
		newUrl.host = 'mbetamony:3000'
		newUrl.protocol = 'http:'
		const newReq = new Request(newUrl, request)

		const apiResponse = await fetch(newReq)
		switch (apiResponse.status) {
			case 200:
				const clone = apiResponse.clone()
				const data = await clone.json()
				this.broadcast(data as string)
			default:
				return apiResponse
		}
	}
	broadcast(message: (ArrayBuffer | ArrayBufferView) | string) {
		console.log('broadcasting')
		if (typeof message !== 'string') {
			message = JSON.stringify(message)
		}
		this.ctx.getWebSockets().forEach((socket) => {
			try {
				socket.send(message as string)
			} catch (err) {
				this.closeOrErrorHandler(socket)
			}
		})
	}
	async webSocketMessage(webSocket: WebSocket, message: string) {
		const data = JSON.parse(message)
		if (data.projectID && data.manuscriptID && data.authToken) {
			const res = await this.fetchListen(data.projectID, data.manuscriptID, data.authToken)
			webSocket.send(JSON.stringify(res))
		}
	}

	async fetchListen(projectID: string, documentID: string, token: string) {
		// for the listen, we can't simply fetch the request the same way we do it for the steps request
		// the listen is initiated on webSockets, and projectID, documentID and token are sent from the websocket
		const res = await fetch(`http://mbetamony:3000/api/v2/doc/${projectID}/manuscript/${documentID}/listen`, {
			headers: this.headers(token),
		})
		try {
			return await res.json()
		} catch (error) {
			console.log(error)
			return ''
		}
	}
	private headers(token: string) {
		return {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json',
		}
	}
	async closeOrErrorHandler(webSocket: WebSocket) {
		try {
			webSocket.close()
		} catch (err) {
			console.log('error closing socket: ' + err)
		}
	}
	async webSocketError(webSocket: WebSocket, error: string) {
		console.log('socket error: ' + error)
		this.closeOrErrorHandler(webSocket)
	}
}
async function runWithErrorHandling(request: Request, func: Function) {
	try {
		return await func()
	} catch (err: any) {
		if (request.headers.get('Upgrade') == 'websocket') {
			let pair = new WebSocketPair()
			pair[1].accept()
			pair[1].send(JSON.stringify({ error: err.stack }))
			pair[1].close(1011, 'Uncaught exception during session setup')
			return new Response(null, { status: 101, webSocket: pair[0] })
		} else {
			return new Response(err.stack, { status: 500 })
		}
	}
}
export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.toml
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return await runWithErrorHandling(request, async () => {
			const url = new URL(request.url)
			const regex = /manuscript\/(.*?)\//
			const match = url.toString().match(regex)
			const manuscriptID = match ? match[1] : ''
			let id: DurableObjectId = env.MY_DURABLE_OBJECT.idFromName(manuscriptID)
			let stub = env.MY_DURABLE_OBJECT.get(id)
			return await stub.fetch(request)
		})
	},
}
