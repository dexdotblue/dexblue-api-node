// load modules
let path      = require("path"),
    fs        = require('fs'),
    WebSocket = require('ws'),
    Web3      = require('web3'),
    BigNumber = require('bignumber.js')
    

// load config files
let config         = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'config/config.json'))),
    clientMethods  = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'config/clientMethods.json'))),
    serverPackages = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'config/serverEvents.json'))),
    serverEvents   = serverPackages.events,
    serverStructs  = serverPackages.structs,
    serverEventIds = {}

// create server event id mapping
for(event in serverEvents){
    serverEventIds[serverEvents[event].id] = event
}

// dexBlue class
module.exports = class DexBlue{
    // constructor function
    constructor(parameters){
        // input validation
        parameters = parameters || {}
        if(typeof parameters != "object") throw ""

        // parse parameters
        this.config  = {
            endpoint     : parameters.endpoint     || config.defaultEndpoint,
            network      : parameters.network      || config.defaultNetwork,
            web3Provider : parameters.web3Provider || config.defaultWeb3Provider,
            account      : parameters.account,
            delegate     : parameters.delegate,
            noAutoAuth   : parameters.noAutoAuth || false
        }
        this.chainId = parameters.chainId || config.chainIds[this.config.network]

        // load utils
        this.utils = new DexBlueUtils(this.config)

        // create request id lister array
        this.rid          = 1
        this.ridListeners = {} 

        // create event listener arrays 
        this.callbacks = {
            "packet"       : [],  // single JSON parsed packet of server packet array

            // websocket event passthrough
            "wsConnected"  : [],  
            "wsMessage"    : [],
            "wsError"      : [],
            "wsDisconnect" : []
        }
        for(let event in serverEvents){
            this.callbacks[event] = []
        }

        // create method wrappers
        this.methods   = {}
        for(let method in clientMethods){
            this.methods[method] = (parameters, callback) => {
                // allow for the passing of just a callback function
                if(typeof parameters == "function"){
                    callback   = parameters
                    parameters = {}
                }else{
                    parameters = parameters || {}
                }

                // validate the provided parameters before sending the packet
                this.utils.validateClientInput(clientMethods[method], parameters)

                // add c parameter, if missing
                parameters.c = method
                return this.sendWithCallback(parameters, callback)
            }
        }

        // connect to server
        let self = this // needed to be able to use ES5 functions which have the arguments object

        this.ws = new WebSocket(this.config.endpoint);

        this.ws.on('open', function(){
            // automatically authenticate, if a private key was provided at startup
            if(!self.config.noAutoAuth){
                if(self.config.account){
                    self.authenticate(self.config.account)
                }else if(self.config.delegate){
                    self.authenticateDelegate(self.config.delegate)
                }
            }

            self.callEventListers("wsConnected", arguments);
        })
        this.ws.on('error', function(error){
            self.callEventListers("wsError", error);
            if(Object.keys(self.callbacks.wsError).length == 0) throw error
        })
        this.ws.on('close', function(error){
            self.callEventListers("wsDisconnect", error);
            if(Object.keys(self.callbacks.wsDisconnect).length == 0) throw error
        })

        this.ws.on('message', function(body, flags){
            self.callEventListers("wsMessage", arguments);

            var msgs = JSON.parse(body)

            for(var i in msgs){

                var packet   = msgs[i],
                    chan     = packet[0], //Channel
                    eventId  = packet[1], //Event
                    msg      = packet[2], //Message
                    rid      = packet[3], //Request Id
                    event    = serverEventIds[eventId],
                    parsed

                // store config & listed packets
                if(event == "config") self.configPacket = msg
                if(event == "listed"){
                    self.listedPacket = msg
                    self.listedPacket.tokensByContract = {}
                    for(let symbol in msg.tokens){
                        let token = msg.tokens[symbol]
                        token.symbol = symbol
                        self.listedPacket.tokensByContract[token.contract] = token
                    }
                    for(let symbol in msg.markets){
                        msg.markets[symbol].symbol = symbol
                    }
                }

                // parse server packets
                parsed = self.utils.parseServerPacket(serverEvents[event], msg)

                // call event listeners
                self.callEventListers(event, [chan, event, msg, parsed]);
                
                // call rid listeners (callbacks)
                if(rid && self.ridListeners[rid]){
                    var handler = self.ridListeners[rid]

                    // Normal callback is used
                    if(handler.type == "callback"){
                        if(event == "error"){
                            handler.callback(chan, event, msg, msg, parsed)
                        }else{
                            handler.callback(chan, event, null, msg, parsed)
                        }

                    // Promise is used
                    }else if(handler.type == "promise"){
                        if(event == "error"){
                            handler.reject(new Error(msg))
                        }else{
                            handler.resolve(chan, event, msg, parsed)
                        }
                    }

                    delete self.ridListeners[rid]
                }

                // call packet listeners
                self.callEventListers("packet", [packet]);
            }
        })
    }
    // add an event lister to a server event
    on(event, callback){
        // input validation
        if(!this.callbacks[event]) throw "unknown event: "+event
        if(typeof(callback) != "function") throw "invalid or missing callback function"

        // add event listener to event
        this.callbacks[event].push(callback)
    }
    // remove an event lister for a server event
    clear(event, callback){
        // input validation
        if(!this.callbacks[event]) throw "unknown event: "+event
        if(typeof(callback) != "function") throw "invalid or missing callback function"

        // remove event listener from event
        this.callbacks[event].splice(this.callbacks[event].indexOf(callback), 1)
    }
    // call event Listeners
    callEventListers(event, parameters){
        // allow passing of single parameters
        if(!Array.isArray(parameters)) parameters = [parameters]

        // call all event listeners
        for(let i in this.callbacks[event]){
            this.callbacks[event][i].apply(null, parameters)
        }
    }
    sendWithCallback(message, callback){
        let rid     = this.rid++

        // allow for the passing of single messages as well as arrays
        message = Array.isArray(message)?message:[message]

        // add rid to every packet
        for(let i in message){
            message[i].rid = rid
        }

        this.ws.send(JSON.stringify(message))

        if(typeof(callback) == "function"){
            this.ridListeners[rid] = {
                type     : "callback",
                callback : callback
            }
        }else{
            return new Promise((resolve, reject) => {
                this.ridListeners[rid] = {
                    type    : "promise",
                    resolve : resolve,
                    reject  : reject
                }
            })
        }
    }
    send(message){
        this.ws.send(JSON.stringify(message))
    }
    authenticate(privateKey, callback){
        let nonce = Date.now()

        this.methods.authenticate({
            message   : nonce.toString(),
            nonce     : nonce,
            signature : this.utils.web3.eth.accounts.sign(nonce.toString(), privateKey).signature
        }, callback)

        this.config.account = privateKey
    }
    authenticateDelegate(privateKey, callback){
        let nonce = Date.now()

        this.methods.authenticateDelegate({
            message   : nonce.toString(),
            nonce     : nonce,
            signature : this.utils.web3.eth.accounts.sign(nonce.toString(), privateKey).signature
        }, callback)

        this.config.delegate = privateKey
    }
    placeOrder(order, callback){
        // fetch listed packet, if it was not requested already
        if(!this.listedPacket){
            this.methods.getListed(() => {
                this.placeOrder(order, callback)
            })
        }

        // check the market parameter, if it exists
        if(order.market){
            // check if the market id id known
            if(!(order.market = this.listedPacket.markets[order.market])) throw new Error("Unknown Market")
        }else{
            if(
                !order.buyToken
                || !order.sellToken
            ){
                throw new Error("Please provide either the market or the buyToken and sellToken parameters")
            }

            // also support token symbols instead of contracts
            let buyToken  = this.listedPacket.tokensByContract[order.buyToken]  || this.listedPacket.tokens[order.buyToken],
                sellToken = this.listedPacket.tokensByContract[order.sellToken] || this.listedPacket.tokens[order.sellToken]

            if(!buyToken || !sellToken) throw new Error("Unknown token")

            order.sellToken = sellToken.contractAddress
            order.buyToken  = buyToken.contractAddress
            
            // derive the market of the order
            if(order.market = this.listedPacket.markets[buyToken.symbol  + sellToken.symbol]){
                order.direction = "buy"
            }else if(order.market = this.listedPacket.markets[sellToken.symbol + buyToken.symbol]){
                order.direction = "sell"
            }else{
                throw new Error("Unknown Market")
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
            order.amount = new BigNumber(order.amount).times(Math.pow(10, this.listedPacket.tokens[order.market.traded].decimals))
        }

        // accept side parameter instead of direction or derive from positive/negative amount
        if(!order.direction){
            if(order.side){
                order.direction = order.side
            }else if(order.amount){
                order.direction = order.amount.gt(0)?"buy":"sell"
            }
        }
        if(order.direction !== "buy" && order.direction !== "sell") throw new Error("Unknown Order Direction")
        if(order.direction == "buy"  && order.amount.lt(0))         throw new Error("Negative amount for buy order.")

        // make amount positive after direction was set
        if(order.amount && order.amount.lt(0)) order.amount = order.amount.times(-1)

        if(
            !order.buyToken
            || !order.sellToken
        ){
            if(order.direction == "buy"){
                order.buyToken  = this.listedPacket.tokens[order.market.traded].contract
                order.sellToken = this.listedPacket.tokens[order.market.quote ].contract
            }else{
                order.buyToken  = this.listedPacket.tokens[order.market.quote ].contract
                order.sellToken = this.listedPacket.tokens[order.market.traded].contract
            }
        }

        // support rate & amount instead of 
        if(
            !order.buyAmount
            || !order.sellAmount
        ){
            if(
                !order.amount
                || !order.rate
            ) throw new Error("Please the amount and rate or buyAmount and sellAmount parameters")
            
            if(order.direction == "buy"){
                order.buyAmount  = order.amount.integerValue(1)
                order.sellAmount = order.amount.div(Math.pow(10,this.listedPacket.tokens[order.market.traded].decimals)).times(order.rate).times(Math.pow(10,this.listedPacket.tokens[order.market.quote].decimals)).integerValue(1)
            }else{
                order.sellAmount = order.amount.integerValue(1)
                order.buyAmount  = order.amount.div(Math.pow(10,this.listedPacket.tokens[order.market.traded].decimals)).times(order.rate).times(Math.pow(10,this.listedPacket.tokens[order.market.quote].decimals)).integerValue(1)
            }
        }

        // sign the order if no signature was provided
        if(
            !order.signature
            && (this.config.account || this.config.delegate)
        ){
            order.nonce           = order.nonce           || Date.now()
            order.expiry          = order.expiry          || 1746144325 // 02.05.2025 02:05:25
            order.contractAddress = order.contractAddress || this.configPacket.contractAddress

            order.hash            = this.utils.hashOrder(order)
            order.signature       = this.utils.web3.eth.accounts.sign(this.utils.hashOrder(order), this.config.account || this.config.delegate).signature
            order.signatureFormat = "sign"

            delete order.contractAddress
            delete order.hash
        }

        order.buyAmount  = order.buyAmount.toString(10)
        order.sellAmount = order.sellAmount.toString(10)
        order.market     = order.market.symbol
        
        delete order.amount
        delete order.direction
        delete order.side
        delete order.rate

        this.methods.placeOrder(order, callback)
    }
    disconnect(){
        this.ws.close()
    }
}

class DexBlueUtils{
    constructor(parameters){
        // input validation
        parameters = parameters || {}
        if(typeof parameters != "object") throw ""

        this.web3 = new Web3(parameters.web3Provider);
    }
    validateClientInput(expected, parameters){
        // check if all expected are in parameters
        for(var key in expected){
            var check = expected[key],
                val   = parameters[key]

            // check if parameter is there
            if(typeof val != "undefined"){
                // check if parameter has the right type
                switch(check.type){
                    case "uint":
                        if(!Number.isInteger(val) || val < 0) throw 'Malformed parameter: '+key+', expected an unsigned integer.'
                        break;
                    case "uintString":
                        if(!Number.isInteger(Number(val)) || Number(val) < 0) throw 'Malformed parameter: '+key+', expected an unsigned integer wrapped in a string (to prevent rounding errors).'
                        break;
                    case "bool":
                        if(typeof(val) !== "boolean") throw 'Malformed parameter: '+key+', expected a boolean.'
                        break;
                    case "string":
                        if(typeof(val) !== "string") throw 'Malformed parameter: '+key+', expected a string.'
                        break;
                    case "hexString":
                        if(!/^0x[0-9a-fA-F]+$/.test(val)) throw 'Malformed parameter: '+key+', expected a hex string (with leading 0x).'
                        break;
                    case "array":
                        if(!Array.isArray(val)) throw 'Malformed parameter: '+key+', expected an array.'
                        if(check.elements){
                            for(let i in val){

                                this.validateClientInput({"array element":check.elements},{"array element":val[i]})
                            }
                        }
                        break;
                    default:
                        throw 'Unimplemented type: '+check.type+' in key '+key
                        break;
                }
                if(check.length && check.length !== val.length){
                    throw 'Malformed input: '+key+" expected a string length of "+ check.length + " characters. Input has length " + val.length + "."
                }
                if(check.minLength && check.minLength > val.length){
                    throw 'Malformed input: '+key+" expected a string length of at least "+ check.minLength + " characters. Input has length " + val.length + "."
                }
                if(check.maxLength && check.maxLength < val.length){
                    throw 'Malformed input: '+key+" expected a string length of at most "+ check.maxLength + " characters. Input has length " + val.length + "."
                }
            }else if(!check.optional){
                throw 'Missing parameter: '+key
            }
        }
        // check if parameters have no unknown keys
        for(key in parameters){
            if(
                !expected[key] 
                && key != "c"
            ){
                throw "Unexpected parameter: '"+key+"'. Expected parameters are: "+(Object.keys(expected).length?Object.keys(expected).join(', '):"none for this command")+"."
            }
        }
    }
    parseServerPacket(format, msg){
        let parsed
        
        // check if value is undefined
        if(msg === null){
            if(!format.optional) throw "invalid format spec"
            return null
        }

        switch(format.type){
            // simple types
            case "uint":
            case "int":
            case "float":
            case "string":
            case "hexString":
            case "bool":
                parsed = msg
                break;
            case "binbool":
                parsed = msg?true:false
                break;
            case "intString":
            case "uintString":
            case "floatString":
                parsed = new BigNumber(msg)
                break;

            // structures
            case "array":
                if(format.fields){
                    parsed = {}

                    if(format.fields.length != msg.length) throw "invalid format spec"

                    for(let i in format.fields){
                        let field = format.fields[i]
                        parsed[field.name] = this.parseServerPacket(field, msg[i])
                    }
                }else if(format.elements){
                    parsed = []
                    for(let i in msg){
                        parsed.push(this.parseServerPacket(format.elements, msg[i]))
                    }
                }else{
                    throw "invalid format spec"
                }
                break;
            case "object":
                if(format.keys){
                    parsed = {}
                    for(let key in format.keys){
                        if(msg[key]){
                            parsed[key] = this.parseServerPacket(format.keys[key], msg[key])
                        }else if(!format.keys[key].optional){
                            throw "invalid format spec"
                        }
                    }
                }else if(format.elements){
                    parsed = {}
                    for(let key in msg){
                        parsed[key] = this.parseServerPacket(format.elements, msg[key])
                    }
                }else{
                    throw "invalid format spec"
                }
                break;
            case "struct":
                if(serverStructs[format.struct]){
                    let struct = serverStructs[format.struct]
                    parsed = this.parseServerPacket(struct, msg)
                }else{
                    throw "invalid format spec"
                }
                break;
            default:
                throw "invalid format spec"
                break;
        }

        return parsed
    }
    hashOrder(order){
        return this.web3.utils.soliditySha3(
            {type: 'address', value: order.sellToken.toLowerCase()},
            {type: 'uint128', value: order.sellAmount.toString(10)},
            {type: 'address', value: order.buyToken.toLowerCase()},
            {type: 'uint128', value: order.buyAmount.toString(10)},
            {type: 'uint32',  value: order.expiry},
            {type: 'uint64',  value: order.nonce},
            {type: 'address', value: (order.contractAddress || self.config.contractAddress).toLowerCase()}
        )
    }
}