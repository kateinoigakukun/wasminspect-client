import { SocketRequest, TextResponse } from "./socket-rpc"
import WS from "./websocket-constructor"
import getContext from "./worker-context-constructor"
import { WorkerRequest, WorkerResponse } from "./worker-rpc";

class BlockingQueue<T> {
    private pendings: T[];
    private onpush: ((message: T) => void) | null

    constructor() {
        this.pendings = []
        this.onpush = null;
    }
    push(message: T) {
        if (this.onpush) {
            this.onpush(message)
        } else {
            this.pendings.push(message)
        }
    }

    consume(f: (message: T) => void) {
        if (this.pendings.length > 0) {
            const head = this.pendings.shift();
            f(head);
            return;
        } else {
            if (this.onpush != null) {
                console.error("Can't wait multiple event at once.")
                return;
            }
            this.onpush = (message) => {
                this.onpush = null;
                f(message)
            };
        }
    }
}

type State = {
    debugEnabled: boolean,
    isBlocking: boolean,
    socket: Socket | null,
    waitingPrologue: BlockingQueue<WorkerResponse>,
    waitingEpilogue: BlockingQueue<string>,
}

class Socket {
    ws: typeof WS.WebSocket["prototype"];
    onmessage: () => void;

    constructor(addr: string) {
        const ws = new WS.WebSocket(addr);
        this.ws = ws;
        ws.onopen = () => {
            ctx.postMessage({ type: "OnSocketOpen" } as WorkerResponse)
        }
        ws.onmessage = (event: any) => {
            acceptSocketEvent(event.data, state)
        }
    }
}

const acceptSocketEvent = (eventData: string | ArrayBuffer, state: State) => {
    if (state.debugEnabled) {
        console.log("[wasminspect-web] [main thread] <- [worker thread] <- [socket] ", eventData)
    }
    let response: WorkerResponse;
    if (typeof eventData === "string") {
        const body = JSON.parse(eventData) as TextResponse;
        response = { type: "SocketResponse", inner: { type: "TextResponse", body } } as WorkerResponse;
    } else {
    }

    if (state.isBlocking) {
        state.waitingPrologue.push(response);
    } else {
        ctx.postMessage(response)
    }
};

const acceptWorkerRequest = (workerRequest: WorkerRequest & { isBlocking: boolean }, state: State) => {
    if (state.debugEnabled) {
        console.log("[wasminspect-web] [main thread] -> [worker thread] ", JSON.stringify(workerRequest))
    }
    const oldIsBlocking = state.isBlocking;
    state.isBlocking = workerRequest.isBlocking;

    switch (workerRequest.type) {
        case "Configure": {
            state.socket = new Socket(workerRequest.socketAddr);
            state.debugEnabled = workerRequest.debugEnabled;
            break;
        }
        case "BlockingPrologue": {
            if (!oldIsBlocking) {
                console.error("BlockingPrologue should be called after blocking request");
            }
            state.waitingPrologue.consume((msg) => {
                const intView = new Uint32Array(workerRequest.sizeBuffer, 0, 1);
                const flagView = new Uint8Array(workerRequest.sizeBuffer, 4, 1);
                const json = JSON.stringify(msg);
                Atomics.store(intView, 0, json.length);
                Atomics.store(flagView, 0, 1);
                state.waitingEpilogue.push(json);
            });
            break;
        }
        case "BlockingEpilogue": {
            if (!oldIsBlocking) {
                console.error("BlockingEpilogue should be called after blocking request");
            }
            state.waitingEpilogue.consume((json) => {
                const stringView = new Uint16Array(workerRequest.jsonBuffer, 0, json.length);
                const flagView = new Uint8Array(workerRequest.jsonBuffer, json.length * 2, 1);
                for (let idx = 0; idx < json.length; idx++) {
                    Atomics.store(stringView, idx, json.charCodeAt(idx));
                }
                Atomics.store(flagView, 0, 1);
            });
            break;
        }
        case "SocketRequest": {
            const request: SocketRequest = workerRequest.inner;
            switch (request.type) {
                case "TextRequest": {
                    const json = JSON.stringify(request.body);
                    state.socket.ws.send(json);
                    break;
                }
                case "BinaryRequest": {
                    state.socket.ws.send(request.body);
                }
            }
            break;
        }
    }
};

const ctx = getContext();
const state: State = {
    debugEnabled: false,
    isBlocking: false,
    socket: null,
    waitingPrologue: new BlockingQueue<WorkerResponse>(),
    waitingEpilogue: new BlockingQueue<string>(),
}

ctx.addEventListener("message", (event: any) => {
    const workerRequest = event.data as WorkerRequest & { isBlocking: boolean };
    acceptWorkerRequest(workerRequest, state);
})
