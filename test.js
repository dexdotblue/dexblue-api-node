var DexBlue  = require('./index.js'),
    WebSocket = require('ws'),
    Web3      = require('web3'),
    BigNumber = require('bignumber.js')

var API = new DexBlue()

API.on('wsConnected', function(){
    API.methods.getListed(function(market, event, error, packet){
        API.methods.subscribe({
            markets : Object.keys(packet.markets),
            events  : ["book20d5"]
        })
    })
})

API.on('orderBookUpdate', console.log)

API.on('orderBookSnapshot', console.log)

API.on('wsError', function(error){
    throw error
})

// API.on('config', console.log)