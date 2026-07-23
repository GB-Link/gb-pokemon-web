
export class WebSocketClient {
    constructor() {
        this.ws = null;
        this.url = null;
        this.isConnected = false;
        this.listeners = {}; // Map of type -> callback
        this.sendDict = {}; // Data ready to be sent when requested
        this.recvDict = {}; // Store most recent received data by type
        this.debug = false; // Gate per-packet console dumps (hot loops send ~100 pkts/sec)
        this.onDisconnect = null; // Called on unexpected close (not user-initiated)

        // Constants from HighLevelListener.py
        this.REQ_INFO_POSITION = 0;
        this.LEN_POSITION = 5;
        this.DATA_POSITION = 7; // LEN_POSITION + 2
        this.SEND_REQUEST = "S";
        this.GET_REQUEST = "G";
    }

    connect(url) {
        // Drop any previous session completely so stale sockets, cached
        // dicts and listeners can never leak into the new trade.
        if (this.ws) {
            this.disconnect();
        }
        this.sendDict = {};
        this.recvDict = {};
        this.listeners = {};

        return new Promise((resolve, reject) => {
            this.url = url; // Store URL for potential reconnection
            const socket = new WebSocket(url);
            this.ws = socket;

            socket.onopen = () => {
                if (this.ws !== socket) return; // superseded by a newer connect
                this.isConnected = true;
                console.log("WebSocket connected");
                resolve();
            };

            socket.onclose = (event) => {
                if (this.ws !== socket) return; // stale socket from a previous session
                console.log(`WebSocket disconnected. Code: ${event.code}, Reason: ${event.reason}`);
                this.isConnected = false;
                if (this.onDisconnect) this.onDisconnect(event);
            };

            socket.onerror = (error) => {
                if (this.ws !== socket) return;
                console.error("WebSocket error:", error);
                reject(error);
            };

            socket.onmessage = async (event) => {
                let data;
                if (event.data instanceof Blob) {
                    data = new Uint8Array(await event.data.arrayBuffer());
                } else {
                    // Assuming binary data for this protocol
                    data = new Uint8Array(event.data);
                }
                if (this.ws !== socket) return;
                this.processReceivedData(data);
            };
        });
    }

    /**
     * Disconnect the WebSocket connection
     */
    disconnect() {
        if (this.ws) {
            const socket = this.ws;
            this.ws = null; // detach first so onclose is ignored as user-initiated
            socket.onclose = null;
            socket.onerror = null;
            socket.onmessage = null;
            try { socket.close(); } catch (_) {}
            this.isConnected = false;
            // Clear cached data
            this.sendDict = {};
            this.recvDict = {};
            this.listeners = {};
            console.log("WebSocket manually disconnected");
        }
    }

    registerListener(type, callback) {
        this.listeners[type] = callback;
    }

    prepareSendData(type, data) {
        // Format: "S" + TYPE(3 chars) + LEN(2 bytes) + DATA
        const encoder = new TextEncoder();
        const header = encoder.encode(this.SEND_REQUEST + type);
        const length = new Uint8Array([(data.length >> 8) & 0xFF, data.length & 0xFF]);

        const packet = new Uint8Array(header.length + length.length + data.length);
        packet.set(header, 0);
        packet.set(length, header.length);
        packet.set(data, header.length + length.length);

        return packet;
    }

    prepareGetData(type) {
        // Format: "G" + TYPE(3 chars)
        const encoder = new TextEncoder();
        return encoder.encode(this.GET_REQUEST + type);
    }

    sendData(type, data) {
        // Store data to be sent when requested (GET)
        this.sendDict[type] = data;

        // Also proactively send it (SEND)
        // Note: The ref. impl. implementation seems to use a "push" model for some things and "pull" for others.
        // HighLevelListener.send_data sends it immediately.
        const packet = this.prepareSendData(type, data);
        if (this.isConnected) {
            if (this.debug) console.log(`WS Send: ${type}`, packet);
            this.ws.send(packet);
        } else {
            console.warn(`WS Send ${type} dropped: not connected`);
            if (this.onDisconnect) this.onDisconnect(null);
        }
    }

    sendGetData(type) {
        const packet = this.prepareGetData(type);
        if (this.isConnected) {
            if (this.debug) console.log(`WS Send GET: ${type}`, packet);
            this.ws.send(packet);
        }
    }

    /**
     * Send raw bytes without any formatting (for link trade handshake).
     */
    sendRaw(data) {
        if (this.isConnected) {
            if (this.debug) console.log(`WS Send Raw:`, data);
            this.ws.send(data);
        }
    }

    processReceivedData(data) {
        if (this.debug) console.log("WS Recv Raw:", data);
        if (data.length < this.LEN_POSITION) return;

        const decoder = new TextDecoder();
        const reqInfo = decoder.decode(data.slice(0, this.LEN_POSITION));
        const reqKind = reqInfo[0];
        const reqType = reqInfo.substring(1, 5);

        if (this.debug) console.log(`WS Recv: Kind=${reqKind}, Type=${reqType}`);

        if (reqKind === this.SEND_REQUEST) {
            // "S" + TYPE + LEN + DATA
            if (data.length < this.DATA_POSITION) return;

            const dataLen = (data[this.LEN_POSITION] << 8) + data[this.LEN_POSITION + 1];
            // console.log(`WS Payload Len: ${dataLen}`);

            if (data.length >= this.DATA_POSITION + dataLen) {
                const payload = data.slice(this.DATA_POSITION, this.DATA_POSITION + dataLen);

                // Store in recvDict for polling access
                this.recvDict[reqType] = payload;

                // Notify listener
                if (this.listeners[reqType]) {
                    this.listeners[reqType](payload);
                } else if (this.debug) {
                    console.warn(`No listener for ${reqType}`);
                }
            }
        } else if (reqKind === this.GET_REQUEST) {
            // "G" + TYPE
            // The server is asking for data of this type.
            // console.log(`WS GET Request: ${reqType}`);
            if (this.sendDict[reqType]) {
                const packet = this.prepareSendData(reqType, this.sendDict[reqType]);
                this.ws.send(packet);
            } else {
                console.warn(`No data prepared for GET ${reqType}`);
            }
        }
    }
}
