// load modules
let fs        = require('fs'),
    WebSocket = require('ws'),
    Web3      = require('web3'),
    BigNumber = require('bignumber.js')
    

// load config files
let config         = JSON.parse(fs.readFileSync('config/config.json')),
    clientMethods  = JSON.parse(fs.readFileSync('config/clientMethods.json')),
    serverEvents   = JSON.parse(fs.readFileSync('config/serverEvents.json')),
    serverEventIds = {}

// create server event id mapping
for(event in serverEvents){
    serverEventIds[serverEvents[event]] = event
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
            web3Provider : parameters.web3Provider || config.defaultWeb3Provider
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
                this.utils.validateClientInput(this.methods[method], parameters)

                // add c parameter, if missing
                parameters.c = method
                return this.sendWithCallback(parameters, callback)
            }
        }

        // connect to server
        let self = this // needed to be able to use ES5 functions which have the arguments object

        this.ws = new WebSocket(this.config.endpoint);

        this.ws.on('open', function(){
            if(callback) callback.apply(null, arguments)
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

                // store config packet
                if(event == "config") self.configPacket = msg

                // parse server packets
                parsed = self.utils.parseServerPacket(serverEvents[event], msg)

                // call event listeners
                self.callEventListers(event, [chan, event, msg, parsed]);
                
                // call rid listeners (callbacks)
                if(rid && self.ridListeners[rid]){
                    var handler = self.ridListeners[rid]

                    // Normal callback is used
                    if(handler.type == "callback"){
                        if(event_name == "error"){
                            handler.callback(chan, event, msg, msg, parsed)
                        }else{
                            handler.callback(chan, event, null, msg, parsed)
                        }

                    // Promise is used
                    }else if(handler.type == "promise"){
                        if(event_name == "error"){
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
                        if(!Number.isInteger(val) || val < 0) throw 'Malformed parameter '+key+', expected an unsigned integer.'
                        break;
                    case "uintString":
                        if(!Number.isInteger(Number(val)) || Number(val) < 0) throw 'Malformed parameter '+key+', expected an unsigned integer wrapped in a string (to prevent rounding errors).'
                        break;
                    case "bool":
                        if(typeof(val) !== "boolean") throw 'Malformed parameter '+key+', expected a boolean.'
                        break;
                    case "string":
                        if(typeof(val) !== "string") throw 'Malformed parameter '+key+', expected a string.'
                        break;
                    case "hexString":
                        if(!/^0x[0-9a-fA-F]+$/.test(val)) throw 'Malformed parameter '+key+', expected a hex string (with leading 0x).'
                        break;
                    case "array":
                        if(!Array.isArray(val)) throw 'Malformed parameter '+key+', expected an array.'
                        if(check.elements){
                            for(i in val){
                                this.validateClientInput({"arrayElement":{type:check.elements}},{"arrayElement":val[i]})
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
        
        switch(format.type){
            // simple types
            case "uint":
            case "string":
            case "hexString":
            case "bool":
                parsed = msg
                break;
            case "binbool":
                parsed = msg?true:false
                break;
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
                parsed = {}

                for(let key in format.keys){
                    if(msg[key]){
                        parsed[key] = this.parseServerPacket(format.keys[i], msg[key])
                    }else if(!format.keys[key].optional){
                        throw "invalid format spec"
                    }
                }
                break;
            default:
                throw "invalid format spec"
                break;
        }

        return parsed
    }
    hashOrder(order){
        return web3Utils.soliditySha3(
            {type: 'address', value: order.buy.toLowerCase()},
            {type: 'address', value: order.sell.toLowerCase()},
            {type: 'uint256', value: order.buyAmount.toString(10)},
            {type: 'uint256', value: order.sellAmount.toString(10)},
            {type: 'uint64',  value: order.nonce},
            {type: 'address', value: order.contractAddress.toLowerCase()}
        )
    }
}