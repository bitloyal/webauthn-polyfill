// TODO: turn into setOptions call
var defaultTimeout = 10;
var defaultAuthPort = 61904;
var maxTimeout = 30 * 60; // max timeout for a call is 30 minutes
var minTimeout = 1; // minimum timeout is 1 second
var defaultTimeout = 30;
var supportedCryptoTypes = ["FIDO"];

/*********************************************************************************
 * IIFE module to keep namespace clean and protect internals...
 *********************************************************************************/
window.webauthn = (function() {
    // TODO: change webAuthnAPI to WebAuthnAPI
    var webAuthnAPI = function() {};
    console.log("Loading WebAuthn polyfill...");

    function _makeRpId(origin) {
        var parser = document.createElement("a");
        parser.href = origin;
        // console.log("RPID:", parser.hostname);
        return parser.hostname;
    }

    var supportedAlgorithms = {
        "aes-cbc": {
            name: "AES-CBC",
            dict: {
                name: "AES-CBC",
            },
            supports: ["encrypt", "decrypt", "generateKey"],
        },
        "aes-ctr": {
            name: "AES-CTR",
            dict: {
                name: "AES-CTR",
            },
            supports: ["encrypt", "decrypt", "generateKey"],
        },
        "aes-gcm": {
            name: "AES-GCM",
            dict: {
                name: "AES-GCM",
            },
            supports: ["encrypt", "decrypt", "generateKey"],
        },
        "pbkdf2": {
            name: "PBKDF2",
            dict: {
                name: "PBKDF2",
            },
            supports: ["derive_key"],
        },
        "md2": {
            name: "MD2",
            dict: {
                name: "MD2",
            },
            supports: ["digest"],
        },
        "md5": {
            name: "MD5",
            dict: {
                name: "MD5",
            },
            supports: ["digest"],
        },
        "sha-1": {
            name: "SHA-1",
            dict: {
                name: "SHA-1",
            },
            supports: ["digest"],
        },
        "sha-256": {
            name: "SHA-256",
            dict: {
                name: "SHA-256",
            },
            supports: ["digest"],
        },
        "sha-384": {
            name: "SHA-384",
            dict: {
                name: "SHA-384",
            },
            supports: ["digest"],
        },
        "sha-512": {
            name: "SHA-512",
            dict: {
                name: "SHA-512",
            },
            supports: ["digest"],
        },
        "rsassa-pkcs1-v1_5": {
            name: "RSASSA-PKCS1-v1_5",
            dict: {
                name: "RSASSA-PKCS1-v1_5",
            },
            supports: ["sign", "verify", "generateKey"],
        },
        "rsaes-pkcs1-v1_5": {
            name: "RSAES-PKCS1-v1_5",
            dict: {
                name: "RSAES-PKCS1-v1_5",
            },
            supports: ["encrypt", "decrypt", "generateKey"],
        }
    };

    function _normalizeAlgorithm(keyAlgorithm) {
        var res = {};
        if (typeof keyAlgorithm === "string") {
            keyAlgorithm = keyAlgorithm.toLowerCase();
            if (keyAlgorithm in supportedAlgorithms) {
                if ("dict" in supportedAlgorithms[keyAlgorithm]) {
                    res = supportedAlgorithms[keyAlgorithm].dict;
                    res = normalizeAlgorithm(res);
                } else {
                    throw new Error("Algorithm didn't have dictionary");
                }
            } else {
                throw new Error("Unknown algorithm");
            }
        } else {
            var key, val, tmp;
            for (key in keyAlgorithm) {
                if (key === "name") {
                    val = keyAlgorithm[key];
                    if (val in supportedAlgorithms) {
                        tmp = supportedAlgorithms[val];
                        tmp = tmp.dict.name;
                    } else {
                        tmp = val;
                    }
                    res[key] = tmp;
                }
                if (key !== "name" && keyAlgorithm[key] in supportedAlgorithms) {
                    res[key] = normalizeAlgorithm(keyAlgorithm[key]);
                } else {
                    res[key] = keyAlgorithm[key];
                }
            }
        }
        return res;
    }

    /**
     * Calls a method on all authenticators
     */
    function _callOnAllAuthenticators(timeoutSeconds, method, args) {
        return new Promise(function(resolve, reject) {
            var pendingTimer = window.setTimeout(function() {
                console.log("makeCredential timed out");
                // TODO: call cancel on all pending authenticators
                var err = new Error("timedOut");
                reject(err);
            }, timeoutSeconds * 1000);

            // attempt to make credentials on each authenticator
            var i, _pendingList = [];
            for (i = 0; i < _authenticatorList.length; i++) {
                // Web API 4.1.1 says to call with: callerOrigin, rpId, account, current.type, normalizedAlgorithm, blacklist, attestationChallenge and clientExtensions
                // External Authenticator Protocol 4.1 says to use the args below
                // console.log("Calling authenticatorMakeCredential[" + i + "]");
                _pendingList.push(
                    _authenticatorList[i][method].apply(_authenticatorList[i], args)
                );
            }

            // basically Promises.all() that doesn't die on failure
            // TODO: this probably doesn"t work if the timer lapses, since it won"t .then() anything after the promise that hung
            // use some version of Promises.race() instead
            function resolveAll(promises) {
                var accumulator = [];
                var ready = Promise.resolve(null);

                promises.forEach(function(promise) {
                    ready = ready.then(function() {
                        return promise;
                    }).then(function(value) {
                        // TODO: if result is cancel, then cancel all pending requests
                        console.log("Got value:", value);
                        accumulator.push(value);
                    }).catch(function(err) {
                        accumulator.push(err);
                    });
                });

                return ready.then(function() {
                    return accumulator;
                });
            }

            resolveAll(_pendingList)
                .then(function(res) {
                    // console.log("all promises resolved:", res);
                    window.clearTimeout(pendingTimer);

                    // find the succesful result or return error
                    var i;
                    for (i = 0; i < res.length; i++) {
                        if (typeof res[i] !== undefined &&
                            !(res[i] instanceof Error)) {
                            console.log(method, "returning", res[i]);
                            return resolve(res[i]);
                        }
                    }
                    return resolve(new Error("No successful authenticatons"));
                })
                .catch(function(err) {
                    console.log("caught error");
                    return reject(err);
                });
        });
    }

    /**
     * Get Credentials
     *
     * FIDO 2.0 Web API Specification, Section 4.1.1
     */
    webAuthnAPI.prototype.makeCredential = function(
        account,
        cryptoParameters,
        attestationChallenge,
        timeoutSeconds,
        blacklist,
        extensions) {
        var callerOrigin = document.origin;
        // console.log("Origin:", callerOrigin);
        var rpId = _makeRpId(callerOrigin);
        // argument checking
        // TODO: check types
        if (timeoutSeconds === undefined) {
            timeoutSeconds = defaultTimeout;
        }
        if (timeoutSeconds < minTimeout) {
            timeoutSeconds = minTimeout;
        }
        if (timeoutSeconds > maxTimeout) {
            timeoutSeconds = maxTimeout;
        }
        if (blacklist === undefined) {
            blacklist = [];
        }
        if (extensions === undefined) {
            extensions = [];
        }
        // Select authenticator

        // Return promise
        // return new Promise(function(resolve, reject) {
        var issuedRequests = [];

        var i, current = null;
        // find a crypto type that meets our needs
        for (i = 0; i < cryptoParameters.length; i++) {
            current = cryptoParameters[i];
            if (supportedCryptoTypes.indexOf(current.type) === -1) {
                continue;
            }

            // WebCrypto Section 18.4, Normalizing Algorithm
            var keyAlgorithm = {
                alg: current.algorithm,
                op: "generateKey"
            };
            current = null;
            // TODO: not quite sure how to make this work from userland...
            var x = _normalizeAlgorithm(keyAlgorithm);
        }
        // should be a valid AlgorithmIdentifier object
        cryptoParameters = current;

        // TODO: process _extensionHookList

        // create clientData hash
        var clientDataBuffer = new ArrayBuffer(JSON.stringify({
            challenge: attestationChallenge,
            facet: callerOrigin,
            hashAlg: "S256" // TODO: S384, S512, SM3
        }));
        // var clientDataHash;
        // TODO: make sure window.crypto.subtle exists
        return window.crypto.subtle.digest({
                    name: "SHA-256",
                },
                clientDataBuffer
            )
            .then(function(clientDataHash) {
                //returns the hash as an ArrayBuffer
                // var hash = new Uint8Array(clientDataHash);
                // console.log(hash);
                return _callOnAllAuthenticators(timeoutSeconds, "authenticatorMakeCredential", [rpId,
                    account,
                    clientDataHash,
                    cryptoParameters, // selectedCrypto parameters
                    blacklist,
                    extensions
                ]);
            });
        // .then(function(ret) {
        //     console.log("ret");
        //     // resolve (ret);
        // })
        // .catch(function(err) {
        //     console.error(err);
        //     reject (err);
        // });
        // });
    };

    /**
     * getAssertion
     */
    webAuthnAPI.prototype.getAssertion = function(
        assertionChallenge,
        timeoutSeconds,
        whitelist,
        extensions
    ) {
        console.log("getAssertion");
        var callerOrigin = document.origin;
        var rpId = _makeRpId(callerOrigin);
        // argument checking
        // TODO: check types
        if (timeoutSeconds === undefined) {
            timeoutSeconds = defaultTimeout;
        }
        if (timeoutSeconds < minTimeout) {
            timeoutSeconds = minTimeout;
        }
        if (timeoutSeconds > maxTimeout) {
            timeoutSeconds = maxTimeout;
        }
        console.log ("Timeout:", timeoutSeconds);

        // new promise
        // Return promise
        // return new Promise(function(resolve, reject) { // TODO: return inner Promise instead
            // initialize issuedRequests
            var issuedRequests = [];

            // create clientData hash
            var clientDataBuffer = new ArrayBuffer(JSON.stringify({
                challenge: assertionChallenge,
                facet: callerOrigin,
                hashAlg: "S256" // TODO: S384, S512, SM3
            }));

            // TODO: make sure window.crypto.subtle exists
            return window.crypto.subtle.digest({ // create clientDataHash
                        name: "SHA-256",
                    },
                    clientDataBuffer
                )
                .then(function(clientDataHash) { // call authenticatorGetAssertion on all authenticators
                    // clientDataHash = new Uint8Array(hash);
                    // console.log(clientDataHash);

                    // TODO: for each authenticator...
                    // - create whitelist
                    // - call authenticatorGetAssertion
                    // - add entry to issuedRequests
                    // wait for timer or results
                    return _callOnAllAuthenticators(timeoutSeconds, "authenticatorGetAssertion", [rpId,
                        assertionChallenge,
                        clientDataHash,
                        whitelist,
                        extensions
                    ]);
                })
                .then(function(res) {
                    console.log ("getAssertion res:", res);
                    res.clientData = clientDataBuffer;
                    return Promise.resolve(res);
                })
                .catch(function(err) {
                    return Promise.reject(err);
                });
        // }.bind(this));
    };

    /*********************************************************************************
     * Everything below this line is an extension to the specification to make authenticators easier to work with
     *********************************************************************************/
    /**
     * Authenticator
     *
     * not part of the FIDO 2.0 specification
     * just a template; can use getters and setters if strict type enforcement is desired
     */
    function fidoAuthenticator() {}
    fidoAuthenticator.prototype = {
        constructor: fidoAuthenticator,
        authenticatorDiscover: function() {},
        authenticatorMakeCredential: function() {
            console.log("got authenticatorMakeCredential");
            return Promise.resolve(null);
        },
        authenticatorGetAssertion: function() {
            console.log("got authenticatorGetAssertion");
            return Promise.resolve(null);
        },
        authenticatorCancel: function() {}
    };
    webAuthnAPI.prototype.fidoAuthenticator = fidoAuthenticator;
    var _authenticatorList = [];

    webAuthnAPI.prototype.addAuthenticator = function(auth) {
        // console.log("addAuthenticator");

        if (auth instanceof fidoAuthenticator) {
            // console.log("Adding authenticator");
            _authenticatorList.push(auth);
        } else {
            console.log("Adding authenticator: Authenticator was wrong type, failing:", auth);
        }
    };

    // removeAuthenticator
    webAuthnAPI.prototype.listAuthenticators = function() {
        // cheap deep copy
        return JSON.parse(JSON.stringify(_authenticatorList));
    };

    webAuthnAPI.prototype.removeAllAuthenticators = function() {
        _authenticatorList = [];
    };
    /*********************************************************************************
     * Everything below this line is an extension to the specification for managing extensions
     *********************************************************************************/
    webAuthnAPI.prototype.addExtension = function(extensionHook) {
        this._extensionHookList.push(extensionHook);
    };

    webAuthnAPI.prototype.removeExtension = function(extensionHook) {
        var index = this._extensionHookList.indexOf(extensionHook);
        if (index === -1) return;
        this._extensionHookList = this._extensionHookList.splice(index, 1);
    };

    // TODO: seal returned object and make all functions non-writeable (for security purposes)
    return new webAuthnAPI();
}());