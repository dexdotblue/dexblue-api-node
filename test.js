var DexBlue  = require('./index.js'),
    WebSocket = require('ws'),
    Web3      = require('web3'),
    BigNumber = require('bignumber.js')

var API = new DexBlue()

API.on('wsConnected', function(){
    API.methods.getListed(console.log)
})

API.on('wsError', function(error){
    throw error
})