# dex.blue Node.js API Wrapper

A Node.JS reference implementation of the dex.blue API.

Full websocket API documentation at [docs.dex.blue](https://docs.dex.blue).

## Installation
```bash
  npm i dexblue-api-node
```

## Introduction

dex.blue is a trustless, non-custodial exchange. This means, that every input which moves funds needs to by signed with your private key.

 You either have to sign orders directly from your wallet address or use a [Delegated Signing Key](https://docs.dex.blue/delegation/).

For the most straightforward integration, which does not require you to directly interact with the blockchain, you can just use our [webinterface](https://dex.blue/trading) for deposits & withdrawals and register a [Delegated Signing Key](https://docs.dex.blue/delegation/) in the settings ⚙ section.

If you want to handle deposits and withdrawals from your bot, please check out [this page](https://docs.dex.blue/contract/) of our documentation.

## Usage


The Private key to sign authentication and order messages has to be passed to the contructor:

```javascript
    var DexBlueWS = require('dexblue-api-node').ws, // import the dex.blue module
        BigNumber = require('bignumber.js')         // the BigNumber.js module is used to deal with all token amounts

    var API = new DexBlueWS({
        // Authenticate an account
        account  : "YOUR_ACCOUNT_PRIVATE_KEY",
        // ...or a delegate
        delegate : "YOUR_DELEGATE_PRIVATE_KEY" 
    })

    API.on("wsOpen", ()=>{
        // Your logic here
    })
```

### Methods

This Library provides a wrapper function for [every method offered by the dex.blue API](https://docs.dex.blue/websocket/), which can be invoked with eg: `API.methods.getOrderBookSnapshot(parameters, callback)`.

For a full list of the available methods and parameters, please refer to the [websocket API documentation](https://docs.dex.blue/websocket/).

Additionally the library offers some helper functions to deal with all of the hard and annoying stuff like hashing and signing:

- `API.authenticate(privKey)` - called automatically, when you pass an account to the constructor
- `API.authenticateDelegate(privKey)` - Called automatically, when you pass an delegate to the constructor
- `API.placeOrder(order, callback)` - This function abstracts all the stress of contructing and signing orders away from you. Very recommended to use this!
- `API.hashOrder(order) returns hash` - This function helps you hashing the order inputs correctly. You then need to sign the order by yourself.

### Event Subscriptions

You can subscribe to any server and websocket events using the following functions:

Events: 
- Market Events:
  - `book20d5` ... `book20d1` Orderbook with a depth of 20 with 5 ... 1 decimal precision (for the rate)
  - `book100d5` ... `book100d1` Orderbook with a depth of 10 with 5 ... 1 decimal precision (for the rate)
  - `bookd5` ... `bookd1` Full orderbook with 5 ... 1 decimal precision (for the rate)
  - `trades` Trades Feed of the market
  - `ticker` The ticker of the market
- Other Events:
  - `rate` subscribe to a ETH to fiat conversion rate e.g. ETHUSD, available are ETH traded against the config.conversion_currencies. (sub with: `{markets:["ETHUSD"],events:["rate"]}`)
  - `chainStats` subscribe to the servers block height and gas price (sub with: `{markets:["ethereum"],events:["chainStats"]}`)
- Websocket Events (no need to subscribe, just listen)
  - `wsOpen` websocket connection is opened
  - `wsMessage` we received a message
  - `wsSend` we are sending a message
  - `wsError` websocket errored
  - `wsClose` websocket conn is closed
  - `packet` called for single packets, the server might return an array of packets in a single websocket message



```javascript
// subscribe to events
API.methods.subscribe({
    markets : ["ETHDAI", "MKRETH"],
    events  : ["trades", "book20d5"]
})

// listen for events
API.on('event', function(chan, packet, parsed){
    console.log("event", parsed)
})
```

## Examples


### Placing an Order.

For all possible parameters, please refer to the [websocket API documentation](https://docs.dex.blue/websocket/#placeorder).

```javascript
API.on('auth', function(chan, packet, session){
    // If you passed an account of delegate to the constructor, you will authenticated automatically
    // All private commands should be sent after we are successfully authenticated

    // This function supports either very abstracted input
    API.placeOrder({
        market : "ETHDAI",
        amount : -1,        // positive amount implies buy order, negative sell
        rate   : 300
    }, function(chan, event, error, msg, order){
        if(error) console.error(error)
        else console.log(order)
    })


    // But also supports all the granular API parameters
    let orderIdentifier = Date.now() // client-set order identifier
    API.placeOrder({
        cid         : orderIdentifier,
        sellToken   : "0x0000000000000000000000000000000000000000",  // ETH
        sellAmount  : "1000000000000000000",                         // 1 ETH
        buyToken    : "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",  // DAI
        buyAmount   : "300000000000000000000",                       // 300 DAI
        expiry      : Math.floor(Date.now() / 1000) + 86400 * 2,     // order is valid 2 days (different from the timeInForce parameter)
        hidden      : false,
        postOnly    : true,     // order is either maker or canceled
        rebateToken : "buy",    // we want to receive our rebate in DAI (the token we buy)
        // ... more possibilities are listed here: https://docs.dex.blue/websocket/#placeorder
    }, function(chan, event, error, msg, order){
        if(error){
            console.error(error)
        } else {
            // do sth, eg: cancel the order again (for examples sake, if you would do that alot we might ban you ^^)
            API.methods.cancelOrder({
              cid : orderIdentifier
            }).then(console.log)  // method calls also support promises
        }
    })
})

```


## Error and Exception Handling

In the following snippet you find all (protocoll related) error events you should handle:

```javascript
API.on('reconnect', (chan, packet, reconnect) => {
    // server sent a reconnect instruction
    console.log("Got instructions to reconnect in "+reconnect.timeout+" seconds. Server message: "+reconnect.message)
})

API.on('wsError', (error) => {
    // handle error (probably resulting in a disconnect)
})
API.on('wsClose', (reason) => {
    // handle disconnect
})
```

## Message-Level Debugging
```javascript
API.on('wsSend', (message) => {
    // Log all outgoing messages
    console.log(">", message)
})
API.on('wsMessage', (message) => {
    // Log all incoming messages
    console.log("<", message)
})
```