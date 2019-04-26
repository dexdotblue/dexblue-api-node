var DexBlue  = require('./index.js'),
    WebSocket = require('ws'),
    Web3      = require('web3'),
    BigNumber = require('bignumber.js')

var API = new DexBlue({
    endpoint : "wss://api.admin.coffee/ws",
    delegate : "0xa1f70f60e3a76a710cb87895ce400e04ff7c8d9f8a28f52f06badafdf46a90f3"
})

API.on('wsConnected', function(){
    API.methods.getListed(function(market, event, error, packet){
        /* API.methods.subscribe({
            markets : Object.keys(packet.markets),
            events  : ["book20d5"]
        }) */
        API.placeOrder({
            market     : "ENGETH",
            buyAmount  : new BigNumber("3000000000"),
            sellAmount : new BigNumber("100000000000000000"),
            buyToken   : packet.tokens.ENG.contract,
            sellToken  : packet.tokens.ETH.contract
        }, console.log)
    })
})

API.on('orderBookUpdate', console.log)

API.on('orderBookSnapshot', console.log)

API.on('wsError', function(error){
    throw error
})

/*/ API.on('config', console.log)

API.methods.authenticate(function(){
    API.methods.placeOrder({
        buyAmount  : 1,
        sellAmount : 1,
        buyToken   : 1,
        sellToken  : 1
    })
})

*/