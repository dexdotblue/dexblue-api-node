"use strict";
// Load modules
let WebSocket = require("isomorphic-ws"),
    Web3      = require("web3"),
    BigNumber = require("bignumber.js");
    

// Load config files
let config         = require("./config/config.json"),
    clientMethods  = require("./config/clientMethods.json"),
    serverPackages = require("./config/serverEvents.json"),
    serverEvents   = serverPackages.events,
    serverStructs  = serverPackages.structs,
    serverEventIds = {};

// create server event id mapping
for(let event in serverEvents){
    serverEventIds[serverEvents[event].id] = event;
}

class DexBlueWS{
    // Constructor function
    constructor(parameters){
        // Input validation
        parameters = parameters || {};
        if(typeof parameters != "object") throw "";

        // Parse parameters
        this.config  = {
            endpoint     : parameters.endpoint     || config.defaultEndpoint,
            network      : parameters.network      || config.defaultNetwork,
            web3Provider : parameters.web3Provider || config.defaultWeb3Provider,
            account      : parameters.account,
            delegate     : parameters.delegate,
            noAutoAuth   : parameters.noAutoAuth || false
        };

        this.chainId = parameters.chainId || config.chainIds[this.config.network];

        // Load utils
        this.utils = new DexBlueUtils(this.config);

        // Create request id lister array
        this.rid          = 1;
        this.ridListeners = {}; 

        // Create event listener arrays 
        this.callbacks = {
            "packet"       : [],  // single JSON parsed packet of server packet array

            // websocket event passthrough
            "wsOpen"    : [],  
            "wsMessage" : [],
            "wsSend"    : [],
            "wsError"   : [],
            "wsClose"   : []
        };

        for(let event in serverEvents){
            this.callbacks[event] = [];
        }

        // Create method wrappers
        this.methods   = {};
        for(let method in clientMethods){
            this.methods[method] = (parameters, callback) => {
                // Allow for the passing of just a callback function
                if(typeof parameters == "function"){
                    callback   = parameters;
                    parameters = {};
                }else{
                    parameters = parameters || {};
                }

                // Validate the provided parameters before sending the packet
                this.utils.validateClientInput(clientMethods[method], parameters);

                // Add c parameter, if missing
                parameters.c = method;
                return this.sendWithCallback(parameters, callback);
            };
        }

        // Connect to server
        let self = this; // Needed to be able to use ES5 functions which have the arguments object

        this.ws = new WebSocket(this.config.endpoint);

        this.ws.onopen = function(){
            let openArgs = arguments;
            // Automatically authenticate, if a private key was provided at startup
            if(
                (
                    self.config.account
                    || self.config.delegate
                )
                && !self.config.noAutoAuth
            ){
                if(self.config.account){
                    self.authenticate(self.config.account, () => {
                        self.callEventListers("wsOpen", openArgs);
                    });
                }else if(self.config.delegate){
                    self.authenticateDelegate(self.config.delegate, () => {
                        self.callEventListers("wsOpen", openArgs);
                    });
                }
            }else{
                self.callEventListers("wsOpen", openArgs);
            }
        };

        this.ws.onerror = function(error){
            self.callEventListers("wsError", error);
            if(Object.keys(self.callbacks.wsError).length == 0) throw error;
        };

        this.ws.onclose = function(error){
            self.callEventListers("wsClose", error);
            if(Object.keys(self.callbacks.wsClose).length == 0) throw error;
        };

        this.ws.onmessage = function(body){
            self.callEventListers("wsMessage", body);

            var msgs = JSON.parse(body);

            for(var i in msgs){

                var packet   = msgs[i],
                    chan     = packet[0], // Channel
                    eventId  = packet[1], // Event
                    msg      = packet[2], // Message
                    rid      = packet[3], // Request Id
                    event    = serverEventIds[eventId],
                    parsed;

                // Cache config & listed packets
                if(event == "config") self.configPacket = msg;
                if(event == "listed"){
                    self.listedPacket = msg;
                    self.listedPacket.tokensByContract = {};
                    for(let symbol in msg.tokens){
                        let token = msg.tokens[symbol];
                        token.symbol = symbol;
                        self.listedPacket.tokensByContract[token.contract] = token;
                    }
                    for(let symbol in msg.markets){
                        msg.markets[symbol].symbol = symbol;
                    }
                }

                // Parse server packets
                parsed = self.utils.parseServerPacket(serverEvents[event], msg);

                // Call event listeners
                self.callEventListers(event, [chan, event, msg, parsed]);
                
                // Call rid listeners (callbacks)
                if(rid && self.ridListeners[rid]){
                    var handler = self.ridListeners[rid];

                    // Normal callback is used
                    if(handler.type == "callback"){
                        if(event == "error"){
                            handler.callback(chan, event, msg, msg, parsed);
                        }else{
                            handler.callback(chan, event, null, msg, parsed);
                        }

                    // Promise is used
                    }else if(handler.type == "promise"){
                        if(event == "error"){
                            handler.reject(new Error(msg));
                        }else{
                            if(
                                chan != "0" 
                                && typeof(parsed) == Object
                                && !Array.isArray(parsed)
                            ) parsed.market = chan;

                            handler.resolve({
                                chan    : chan,
                                event   : event,
                                message : msg,
                                parsed  : parsed
                            });
                        }
                    }

                    delete self.ridListeners[rid];
                }

                // Call packet listeners
                self.callEventListers("packet", [packet]);
            }
        };
    }
    // Add an event lister to a server event
    on(event, callback){
        // Input validation
        if(!this.callbacks[event]) throw "unknown event: " + event;
        if(typeof(callback) != "function") throw "invalid or missing callback function";

        // Add event listener to event
        this.callbacks[event].push(callback);
    }
    // Remove an event lister for a server event
    clear(event, callback){
        // Input validation
        if(!this.callbacks[event]) throw "unknown event: " + event;
        if(typeof(callback) != "function") throw "invalid or missing callback function";

        // Remove event listener from event
        this.callbacks[event].splice(this.callbacks[event].indexOf(callback), 1);
    }
    // Call event Listeners
    callEventListers(event, parameters){
        // Allow passing of single parameters
        if(!Array.isArray(parameters)) parameters = [parameters];

        // Call all event listeners
        for(let i in this.callbacks[event]){
            this.callbacks[event][i].apply(null, parameters);
        }
    }
    sendWithCallback(message, callback){
        let rid     = this.rid++;

        // Allow for the passing of single messages as well as arrays
        message = Array.isArray(message)?message:[message];

        // Add rid to every packet
        for(let i in message){
            message[i].rid = rid;
        }

        this.send(message);

        if(typeof(callback) == "function"){
            this.ridListeners[rid] = {
                type     : "callback",
                callback : callback
            };
        }else{
            return new Promise((resolve, reject) => {
                this.ridListeners[rid] = {
                    type    : "promise",
                    resolve : resolve,
                    reject  : reject
                };
            });
        }
    }
    send(message){
        let messageString = typeof(message) == "string" ? message : JSON.stringify(message);

        this.ws.send(messageString);

        this.callEventListers("wsSend", messageString);
    }
    authenticate(privateKey, callback){
        let nonce = Date.now();

        this.methods.authenticate({
            message   : nonce.toString(),
            nonce     : nonce,
            signature : this.utils.web3.eth.accounts.sign(nonce.toString(), privateKey).signature
        }, callback);

        this.config.account = privateKey;
    }
    authenticateDelegate(privateKey, callback){
        let nonce = Date.now();

        this.methods.authenticateDelegate({
            message   : nonce.toString(),
            nonce     : nonce,
            signature : this.utils.web3.eth.accounts.sign(nonce.toString(), privateKey).signature
        }, callback);

        this.config.delegate = privateKey;
    }
    placeOrder(order, callback){
        // Fetch listed packet, if it was not requested already
        if(!this.listedPacket){
            this.methods.getListed(() => {
                this.placeOrder(order, callback);
            });
            return;
        }

        // Check the market parameter, if it exists
        if(order.market){
            // Check if the market id id known
            if(!(order.market = this.listedPacket.markets[order.market])) throw new Error("Unknown Market");
        }else{
            if(
                !order.buyToken
                || !order.sellToken
            ){
                throw new Error("Please provide either the market or the buyToken and sellToken parameters");
            }

            // Also support token symbols instead of contracts
            let buyToken  = this.listedPacket.tokensByContract[order.buyToken]  || this.listedPacket.tokens[order.buyToken],
                sellToken = this.listedPacket.tokensByContract[order.sellToken] || this.listedPacket.tokens[order.sellToken];

            if(!buyToken || !sellToken) throw new Error("Unknown token");

            order.sellToken = sellToken.contract;
            order.buyToken  = buyToken.contract;
            
            // Derive the market of the order
            // eslint-disable-next-line no-cond-assign
            if(order.market = this.listedPacket.markets[buyToken.symbol  + sellToken.symbol]){
                order.direction = "buy";
            // eslint-disable-next-line no-cond-assign
            }else if(order.market = this.listedPacket.markets[sellToken.symbol + buyToken.symbol]){
                order.direction = "sell";
            }else{
                throw new Error("Unknown Market");
            }
        }

        // BigNumberify amount parameter if it exists
        if(
            order.amount
            && (
                typeof(order.amount) === "number"
                || typeof(order.amount) === "string"
            )
        ){
            order.amount = new BigNumber(order.amount).times(Math.pow(10, this.listedPacket.tokens[order.market.traded].decimals));
        }

        // Accept side parameter instead of direction or derive from positive/negative amount
        if(!order.direction){
            if(order.side){
                order.direction = order.side;
            }else if(order.amount){
                order.direction = order.amount.gt(0)?"buy":"sell";
            }
        }
        if(order.direction !== "buy" && order.direction !== "sell") throw new Error("Unknown Order Direction");
        if(order.direction == "buy"  && order.amount.lt(0))         throw new Error("Negative amount for buy order.");

        // Make amount positive after direction was set
        if(order.amount && order.amount.lt(0)) order.amount = order.amount.times(-1);

        if(
            !order.buyToken
            || !order.sellToken
        ){
            if(order.direction == "buy"){
                order.buyToken  = this.listedPacket.tokens[order.market.traded].contract;
                order.sellToken = this.listedPacket.tokens[order.market.quote ].contract;
            }else{
                order.buyToken  = this.listedPacket.tokens[order.market.quote ].contract;
                order.sellToken = this.listedPacket.tokens[order.market.traded].contract;
            }
        }

        // Support rate & amount instead of 
        if(
            !order.buyAmount
            || !order.sellAmount
        ){
            if(
                !order.amount
                || !order.rate
            ) throw new Error("Please the amount and rate or buyAmount and sellAmount parameters");
            
            if(order.direction == "buy"){
                order.buyAmount  = order.amount.integerValue(1);
                order.sellAmount = order.amount.div(Math.pow(10,this.listedPacket.tokens[order.market.traded].decimals)).times(order.rate).times(Math.pow(10,this.listedPacket.tokens[order.market.quote].decimals)).integerValue(1);
            }else{
                order.sellAmount = order.amount.integerValue(1);
                order.buyAmount  = order.amount.div(Math.pow(10,this.listedPacket.tokens[order.market.traded].decimals)).times(order.rate).times(Math.pow(10,this.listedPacket.tokens[order.market.quote].decimals)).integerValue(1);
            }
        }

        // Sign the order if no signature was provided
        if(
            !order.signature
            && (this.config.account || this.config.delegate)
        ){
            order.nonce           = order.nonce           || Date.now();
            order.expiry          = order.expiry          || 1746144325; // 02.05.2025 02:05:25
            order.contractAddress = order.contractAddress || this.configPacket.contractAddress;

            order.hash            = this.utils.hashOrder(order);
            order.signature       = this.utils.web3.eth.accounts.sign(this.utils.hashOrder(order), this.config.account || this.config.delegate).signature;
            order.signatureFormat = "sign";

            delete order.contractAddress;
            delete order.hash;
        }

        order.buyAmount  = order.buyAmount.toString(10);
        order.sellAmount = order.sellAmount.toString(10);
        order.market     = order.market.symbol;
        
        delete order.amount;
        delete order.direction;
        delete order.side;
        delete order.rate;

        this.methods.placeOrder(order, callback);
    }
    disconnect(){
        this.ws.close();
    }
}

class DexBlueUtils{
    constructor(parameters){
        // Input validation
        parameters = parameters || {};
        if(typeof parameters != "object") throw "";

        this.web3 = new Web3(parameters.web3Provider);
    }
    validateClientInput(expected, parameters){
        // Check if all expected are in parameters
        for(var key in expected){
            var check = expected[key],
                val   = parameters[key];

            // Check if parameter is there
            if(typeof val != "undefined"){
                // Check if parameter has the right type
                switch(check.type){
                case "uint":
                    if(!Number.isInteger(val) || val < 0) throw "Malformed parameter: "+key+", expected an unsigned integer.";
                    break;
                case "uintString":
                    if(!Number.isInteger(Number(val)) || Number(val) < 0) throw "Malformed parameter: "+key+", expected an unsigned integer wrapped in a string (to prevent rounding errors).";
                    break;
                case "bool":
                    if(typeof(val) !== "boolean") throw "Malformed parameter: "+key+", expected a boolean.";
                    break;
                case "string":
                    if(typeof(val) !== "string") throw "Malformed parameter: "+key+", expected a string.";
                    break;
                case "hexString":
                    if(!/^0x[0-9a-fA-F]+$/.test(val)) throw "Malformed parameter: "+key+", expected a hex string (with leading 0x).";
                    break;
                case "array":
                    if(!Array.isArray(val)) throw "Malformed parameter: "+key+", expected an array.";
                    if(check.elements){
                        for(let i in val){

                            this.validateClientInput({"array element":check.elements},{"array element":val[i]});
                        }
                    }
                    break;
                default:
                    throw "Unimplemented type: "+check.type+" in key "+key;
                }
                if(check.length && check.length !== val.length){
                    throw "Malformed input: "+key+" expected a string length of "+ check.length + " characters. Input has length " + val.length + ".";
                }
                if(check.minLength && check.minLength > val.length){
                    throw "Malformed input: "+key+" expected a string length of at least "+ check.minLength + " characters. Input has length " + val.length + ".";
                }
                if(check.maxLength && check.maxLength < val.length){
                    throw "Malformed input: "+key+" expected a string length of at most "+ check.maxLength + " characters. Input has length " + val.length + ".";
                }
            }else if(!check.optional){
                throw "Missing parameter: "+key;
            }
        }
        // Check if parameters have no unknown keys
        for(key in parameters){
            if(
                !expected[key] 
                && key != "c"
            ){
                throw "Unexpected parameter: '"+key+"'. Expected parameters are: "+(Object.keys(expected).length?Object.keys(expected).join(", "):"none for this command")+".";
            }
        }
    }
    parseServerPacket(format, msg){
        let parsed;
        
        // Check if value is undefined
        if(msg === null){
            if(!format.optional) throw "invalid format spec";
            return null;
        }

        switch(format.type){
        // Simple types
        case "uint":
        case "int":
        case "float":
        case "string":
        case "hexString":
        case "bool":
            parsed = msg;
            break;
        case "binbool":
            parsed = msg?true:false;
            break;
        case "intString":
        case "uintString":
        case "floatString":
            parsed = new BigNumber(msg);
            break;

            // Structures
        case "array":
            if(format.fields){
                parsed = {};

                if(format.fields.length != msg.length) throw "invalid format spec";

                for(let i in format.fields){
                    let field = format.fields[i];
                    parsed[field.name] = this.parseServerPacket(field, msg[i]);
                }
            }else if(format.elements){
                parsed = [];
                for(let i in msg){
                    parsed.push(this.parseServerPacket(format.elements, msg[i]));
                }
            }else{
                throw "invalid format spec";
            }
            break;
        case "object":
            if(format.keys){
                parsed = {};
                for(let key in format.keys){
                    if(msg[key]){
                        parsed[key] = this.parseServerPacket(format.keys[key], msg[key]);
                    }else if(!format.keys[key].optional){
                        throw "invalid format spec";
                    }
                }
            }else if(format.elements){
                parsed = {};
                for(let key in msg){
                    parsed[key] = this.parseServerPacket(format.elements, msg[key]);
                }
            }else{
                throw "invalid format spec";
            }
            break;
        case "struct":
            if(serverStructs[format.struct]){
                let struct = serverStructs[format.struct];
                parsed = this.parseServerPacket(struct, msg);
            }else{
                throw "invalid format spec";
            }
            break;
        default:
            throw "invalid format spec";
        }

        return parsed;
    }
    hashOrder(order){
        return this.web3.utils.soliditySha3(
            {type: "address", value: order.sellToken.toLowerCase()},
            {type: "uint128", value: order.sellAmount.toString(10)},
            {type: "address", value: order.buyToken.toLowerCase()},
            {type: "uint128", value: order.buyAmount.toString(10)},
            {type: "uint32",  value: order.expiry},
            {type: "uint64",  value: order.nonce},
            {type: "address", value: (order.contractAddress || self.config.contractAddress).toLowerCase()}
        );
    }
}

// Export Classes
module.exports = {
    ws      : DexBlueWS,
    utils   : DexBlueUtils,
    default : DexBlueWS
};